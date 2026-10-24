// Turns spoken or typed commands into room ops: local model (through the laptop bridge) or the
// built-in parser, then placement planning, undo history and spoken replies.
import { Emitter } from "./util/emitter.js";
import { makeId, rng } from "./util/ids.js";
import { stripWake } from "./core/wake.js";
import { parseCommand } from "./core/parse.js";
import { planIntents } from "./core/execute.js";
import { summarize } from "./core/room-state.js";
import { resolvePlacement } from "./core/place.js";
import { allMeta, getMeta, registerMeta } from "./parts/meta/index.js";
import { metaOfRecord, sizeOfRecord, registerBuilder, DESIGNING } from "./parts/build/index.js";
import { buildBlueprint } from "./parts/build/blueprint.js";
import { normalizeBlueprint, slug } from "./core/blueprint.js";
import { matchPart, normalizeText } from "./core/lexicon.js";
import { classifySketch, projectStrokes, sketchBounds } from "./core/sketch.js";
import { WAKE_WORDS } from "./config.js";
import { isChatter, isThing, expandCategories } from "./core/asks.js";
import { addressAdvisor, kingdomQuery, kingdomReport, kingdomStats, advisorAck, getAdvisor } from "./core/kingdom.js";

// Intents that need the drawing and maybe the model, handled here instead of in planIntents.
const MARKER_INTENTS = new Set(["realize", "guess", "correct"]);
const FLOATERS = new Set(["fly", "swim", "float"]);
const BEHAVIOR_WORDS = [
  ["swim", /fish|shark|whale|dolphin|eel|squid|octopus|jellyfish|submarine|turtle/],
  ["fly", /bird|plane|airplane|jet|dragon|bat|butterfly|bee|eagle|owl|helicopter|ufo|rocket|kite|duck|angel/],
  ["hop", /frog|rabbit|bunny|kangaroo|grasshopper|toad/],
  ["walk", /dog|cat|horse|person|man|woman|robot|cow|pig|sheep|dinosaur|bear|lion|tiger|elephant|giraffe|chicken|spider|monster|zombie|knight/],
  ["roll", /car|truck|bus|tank|train|wheel|bike|bicycle|skateboard|tire/],
  ["bounce", /ball|balloon animal/],
  ["sway", /tree|flower|plant|palm|grass|cactus/],
  ["float", /ghost|balloon|cloud|bubble|jellyfish|spirit|star|sun|moon|heart/],
];

function behaviorFor(name) {
  const text = String(name || "").toLowerCase();
  for (const [kind, re] of BEHAVIOR_WORDS) if (re.test(text)) return kind;
  return "none";
}

// Catalog part for a free-form name, only when the name's head noun is an exact catalog match
// ("dragon statue" is not a statue, "horse" is not a house).
function headPart(text) {
  const hit = matchPart(text, allMeta());
  const words = normalizeText(text).split(" ").filter(Boolean).length;
  return hit && hit.end === words && hit.score >= 0.95 ? hit.name : "";
}

function withArticle(noun) {
  const n = String(noun || "thing").trim();
  return /^(a|an|the|some)\s/i.test(n) ? n : `${/^[aeiou]/i.test(n) ? "an" : "a"} ${n}`;
}

const HISTORY_LIMIT = 60;
// A marker nobody is designing (its device reloaded or closed mid-design) is taken over after this.
const ORPHAN_MS = 6 * 60 * 1000;


export class Runner extends Emitter {
  // send(op): applies locally and forwards to the bridge. getPlayer(): pose of whoever commands act for.
  constructor({ room, send, getNet, getPlayer, getUser, settings, getDraw = () => null }) {
    super();
    this.getDraw = getDraw;
    this.lastRealized = null;
    this.room = room;
    this.send = send;
    this.getNet = getNet;
    this.getPlayer = getPlayer;
    this.getUser = getUser;
    this.settings = settings;
    this.history = [];
    this.lastIds = [];
    this.modelAvailable = false;
    this.modelName = "";
    // The bridge can ask for the parser first (a slow laptop model): set from its hello.
    this.parserFirst = false;
    this.inflight = null; // the model command in progress; a newer command replaces it
    this.learned = new Map(); // name -> blueprint designed in this session
    this.designs = Promise.resolve(); // designs run one at a time (the laptop model is one at a time)
    this.pending = new Set(); // placeholder ids queued for a design on this device
    this.busy = 0;
  }

  async run(rawText, { source = "voice" } = {}) {
    const text = String(rawText || "").trim();
    if (!text) return null;
    const wake = stripWake(text, WAKE_WORDS);
    let command = (wake.matched ? wake.rest : text).trim();
    // Kingdom mode: "Builder, build a house right here", "Steward, how is the kingdom?"
    let advisor = null;
    if (this.settings().kingdom) {
      const addressed = addressAdvisor(command);
      advisor = addressed.advisor;
      if (advisor) {
        this.emit("advisor", { id: advisor.id });
        command = addressed.rest;
        if (!command) {
          this.reply(`${advisor.title}: Yes, my liege?`, "system");
          return null;
        }
      }
      const topic = kingdomQuery(command);
      if (topic) {
        const speaker = advisor || getAdvisor("steward");
        if (!advisor) this.emit("advisor", { id: speaker.id });
        const asked = topic === "all" && speaker.topic !== "all" ? speaker.topic : topic;
        this.reply(`${speaker.title}: ${kingdomReport(kingdomStats(this.room.records()), asked)}`, "kingdom");
        return { brain: "kingdom", ops: [], say: [], errors: [] };
      }
    }
    if (!command) {
      this.reply("Listening. Try: spawn a villa to my left.", "system", { speak: false });
      return null;
    }
    const hand = this.settings().hand || "right";
    const parsed = parseCommand(command, { metas: allMeta(), hand });
    const marker = parsed.intents.find((intent) => MARKER_INTENTS.has(intent.do));
    if (marker && parsed.confidence >= 0.8) return this.markerFlow(marker, command);
    const net = this.getNet();
    const online = this.modelAvailable && !!net?.connected;
    // Chatter goes nowhere instead of queueing for the model.
    if (online && isChatter(command, parsed)) {
      this.emit("ignored", { text: command });
      return { brain: "ignored", ops: [], say: [], errors: [] };
    }
    const parserFirst = this.parserFirst || this.settings().fast;
    // "give me a machine gun": the parser understood everything but the thing itself, so the thing
    // is designed on the spot instead of asking the model to read the whole command first.
    const designOnly = online && typeof net.design === "function" && parsed.unknown?.length > 0 && parsed.unknown.every(isThing)
      && parsed.intents.length > 0 && parsed.intents.every((intent) => intent.do === "spawn");
    const useModel = online && !designOnly && !(parserFirst && parsed.confidence >= 0.8);

    let intents = parsed.intents;
    let say = parsed.say ? [parsed.say] : [];
    let brain = "parser";
    if (useModel) {
      this.inflight?.abort();
      const inflight = new AbortController();
      this.inflight = inflight;
      this.busy++;
      this.emit("thinking", { text: command });
      try {
        const player = this.getPlayer();
        const response = await net.command(command, {
          player,
          scene: summarize(this.room.state, player),
          parts: allMeta().filter((m) => m.source !== "builtin").map((m) => m.name),
        }, { signal: inflight.signal });
        if (inflight.signal.aborted) return { brain: "replaced", ops: [], say: [], errors: [] }; // answered, but a newer command took over
        intents = Array.isArray(response.intents) ? response.intents : [];
        say = response.say ? [response.say] : [];
        brain = response.model ? `model:${response.model}` : "model";
        if (!intents.length && parsed.intents.length && parsed.confidence >= 0.8) {
          intents = parsed.intents;
          say = parsed.say ? [parsed.say] : [];
          brain = "parser";
        }
      } catch (err) {
        if (err.code === "aborted") return { brain: "replaced", ops: [], say: [], errors: [] }; // a newer command took over
        console.warn("[runner] model failed, using parser", err);
        say = parsed.say ? [parsed.say] : [];
        if (!parsed.intents.length) say.push(`The local model did not answer (${err.code || err.message}).`);
      } finally {
        if (this.inflight === inflight) this.inflight = null;
        this.idle();
      }
    }
    intents = expandCategories(intents, command);
    if (!intents.length && !say.length) {
      say.push(parsed.unknown?.length
        ? `I don't know "${parsed.unknown.join(", ")}" yet. Try: spawn a crate in front of me.`
        : "I didn't catch a command. Try: spawn a villa to my left.");
    }
    const markerIntent = intents.find((intent) => MARKER_INTENTS.has(intent.do));
    if (markerIntent) return this.markerFlow(markerIntent, command);
    const result = this.exec(intents, { label: command, source: brain, design: online && typeof net.design === "function", hint: command });
    const replies = [...say, ...result.say].filter(Boolean);
    if (advisor) {
      const ack = result.ops.length ? advisorAck(advisor, this.history.length) : "";
      const body = replies.join(" ");
      this.reply(`${advisor.title}: ${[ack, body].filter(Boolean).join(" ")}`, brain);
    } else if (replies.length) this.reply(replies.join(" "), brain);
    else if (result.ops.length) this.reply(describe(result.ops), brain, { speak: false });
    return { brain, ...result };
  }

  // Executes intents directly (UI buttons, HUD menu, model output). Returns { ops, say, errors }.
  exec(intents, { label = "", source = "ui", player = null, decorate = null, design = false, hint = "" } = {}) {
    const pose = player || this.getPlayer();
    const user = pose.user || this.getUser();
    // "it" after a spawn in the same command means that new thing, not the previous command's.
    intents = intents.map((intent, i) => (intents.slice(0, i).some((x) => x?.do === "spawn") ? intent : this.resolveRefs(intent)));
    // An untargeted erase means this device's latest drawing, like "make it real" does.
    const draw = this.getDraw();
    intents = intents.map((intent) => {
      if (intent.do !== "erase" || intent.target || !draw) return intent;
      const drawing = draw.latestDrawing(this.getUser(), pose) || draw.latestDrawing(pose.user, pose);
      return drawing ? { ...intent, target: { id: drawing.id } } : intent;
    });
    const plan = planIntents(intents, {
      state: this.room.state,
      player: pose,
      user,
      hand: this.settings().hand || "right",
      metas: allMeta(),
      metaOf: (part) => getMeta(part) || metaOfRecord({ part, data: this.recordData(part) }),
      sizeOf: (record) => sizeOfRecord(record),
      newId: (prefix = "o") => makeId(prefix),
      rng: rng(),
      design,
    });
    if (plan.undo) {
      this.undo(plan.undo);
      return { ops: [], say: plan.say || [], errors: plan.errors || [] };
    }
    const inverse = [];
    const touched = [];
    for (const op of plan.ops) {
      if (decorate) decorate(op);
      inverse.unshift(...this.room.inverse(op));
      this.send(op);
      if (op.t === "add") touched.push(op.obj.id);
      if (op.t === "set") touched.push(op.id);
      if (op.t === "add" && op.obj.data?.blueprint) this.learnBlueprint(op.obj.data.blueprint);
    }
    if (plan.ops.length) {
      const entry = { label, inverse };
      this.history.push(entry);
      if (this.history.length > HISTORY_LIMIT) this.history.shift();
      for (const op of plan.ops) if (op.t === "add" && op.obj.part === "designing") this.queueDesign(op.obj, hint || label, entry);
    }
    if (touched.length) this.lastIds = touched;
    return { ops: plan.ops, say: plan.say || [], errors: plan.errors || [], source };
  }

  // Magic marker: "make it real", "what is this?", "no, it's a gun".
  async markerFlow(intent, spoken = "") {
    if (intent.do === "correct") return this.correct(intent.label);
    const draw = this.getDraw();
    const pose = this.getPlayer();
    const drawing = intent.target?.id ? this.room.get(intent.target.id) : draw?.latestDrawing(this.getUser(), pose) || draw?.latestDrawing(pose.user, pose);
    if (!drawing || drawing.part !== "drawing") {
      this.reply("Draw something first: hold a marker and pull the trigger (F on a laptop, Draw on the phone).", "system");
      return null;
    }
    let guess = null;
    let source = "sketch";
    if (intent.hint) {
      guess = { guess: intent.hint, part: headPart(intent.hint), confidence: 1, behavior: behaviorFor(intent.hint), say: `${withArticle(intent.hint)}, coming right up.` };
    } else {
      const net = this.getNet();
      if (this.modelAvailable && net?.connected && net.interpret) {
        this.busy++;
        this.emit("thinking", { text: spoken });
        try {
          const stats = draw.statsFor(drawing);
          guess = await net.interpret({ image: draw.snapshotPNG(drawing), ascii: draw.asciiFor(drawing), stats, size: [stats.width, stats.height], hint: spoken, parts: allMeta().filter((m) => m.source !== "builtin").map((m) => m.name) });
          source = guess.model ? `model:${guess.model}` : "model";
        } catch (err) {
          console.warn("[runner] interpret failed, using the offline guesser", err);
        } finally {
          this.idle();
        }
      }
      if (!guess) guess = classifySketch(projectStrokes(drawing.data?.strokes || [])) || { guess: "", part: "", confidence: 0, behavior: "none" };
    }
    if (intent.do === "guess") {
      this.reply(guess.say || (guess.guess ? `Hmm. I think that's ${withArticle(guess.guess)}.` : "I honestly can't tell what that is yet."), source);
      return { guess };
    }
    return this.realize(drawing, guess, source);
  }

  realize(drawing, guess, source) {
    const strokes = drawing.data?.strokes || [];
    const bounds = sketchBounds(strokes);
    const [cos, sin] = [Math.cos(drawing.ry || 0), Math.sin(drawing.ry || 0)];
    const c = bounds.center;
    const center = [drawing.p[0] + c[0] * cos + c[2] * sin, drawing.p[1] + c[1], drawing.p[2] - c[0] * sin + c[2] * cos];
    const behavior = ["swim", "fly", "walk", "hop", "roll", "spin", "float", "bounce", "sway"].includes(guess.behavior) ? guess.behavior : behaviorFor(guess.guess);
    const floating = FLOATERS.has(behavior);
    const y = floating ? Math.max(0.3, center[1] - bounds.size[1] / 2) : 0;
    const drawnSize = Math.max(bounds.size[0], bounds.size[1], 0.2);
    const label = String(guess.guess || "doodle").slice(0, 60);
    const part = getMeta(guess.part) ? guess.part : guess.blueprint?.parts?.length ? "" : headPart(label);
    const decorate = (op) => {
      if (op.t !== "add") return;
      op.obj.label = label;
      if (behavior !== "none") op.obj.data = { ...(op.obj.data || {}), behavior: { kind: behavior, speed: 1 } };
    };
    let intents;
    if (part) {
      const size = getMeta(part).size;
      const scale = Math.min(4, Math.max(0.25, drawnSize / Math.max(size[0], size[1])));
      intents = [{ do: "spawn", what: { part, label }, place: { rel: "at", p: [center[0], y, center[2]] }, scale }];
    } else if (guess.blueprint?.parts?.length) {
      intents = [{ do: "spawn", what: { custom: guess.blueprint, label }, place: { rel: "at", p: [center[0], y, center[2]] } }];
    } else {
      intents = [];
    }
    const removeDrawing = { t: "del", ids: [drawing.id] };
    let result;
    if (intents.length) {
      result = this.exec(intents, { label: "make it real", source, decorate });
      if (result.ops.length) this.sendTracked([removeDrawing], "make it real", true);
    } else {
      // Nothing recognized: the drawing itself becomes solid.
      const id = makeId("o");
      this.sendTracked([removeDrawing, { t: "add", obj: { id, part: "doodle", label, p: drawing.p, ry: drawing.ry, s: 1, data: { strokes, ...(behavior !== "none" ? { behavior: { kind: behavior, speed: 1 } } : {}) }, by: this.getUser(), t: Date.now() } }], "make it real");
      result = { ops: [{ t: "add", obj: { id } }], say: [] };
    }
    const added = result.ops.find((op) => op.t === "add");
    if (added) {
      this.lastRealized = { id: added.obj.id, guess: label, p: added.obj.p || drawing.p, drawnSize };
      this.lastIds = [added.obj.id];
    }
    const line = guess.say || (guess.guess ? `That's ${withArticle(guess.guess)}!${behavior !== "none" ? ` Watch it ${behavior}.` : ""}` : "I couldn't tell what that is, so I made your drawing solid.");
    this.reply(line, source);
    return result;
  }

  // "No, it's a gun": swap the last realized thing for the named one, in the same spot.
  async correct(label) {
    const prev = this.lastRealized && this.room.get(this.lastRealized.id);
    if (!prev) {
      this.reply(`I haven't made anything from a drawing yet. Draw it, then say "make it real".`, "system");
      return null;
    }
    const name = String(label || "").trim();
    const behavior = behaviorFor(name);
    const part = headPart(name);
    const at = { rel: "at", p: [prev.p[0], FLOATERS.has(behavior) ? Math.max(0.3, prev.p[1]) : 0, prev.p[2]] };
    const decorate = (op) => {
      if (op.t !== "add") return;
      op.obj.label = name;
      if (behavior !== "none") op.obj.data = { ...(op.obj.data || {}), behavior: { kind: behavior, speed: 1 } };
    };
    let spawn = null;
    if (part) {
      const size = getMeta(part).size;
      spawn = { do: "spawn", what: { part, label: name }, place: at, scale: Math.min(4, Math.max(0.25, (this.lastRealized.drawnSize || 1) / Math.max(size[0], size[1]))) };
    } else {
      const net = this.getNet();
      if (this.modelAvailable && net?.connected) {
        this.busy++;
        this.emit("thinking", { text: name });
        try {
          const response = await net.command(`spawn ${withArticle(name)}`, { player: this.getPlayer(), scene: [], parts: [] });
          const found = (response.intents || []).find((i) => i.do === "spawn");
          if (found) spawn = { ...found, place: at, count: 1 };
        } catch (err) {
          console.warn("[runner] correction model call failed", err);
        } finally {
          this.idle();
        }
      }
      if (!spawn) spawn = { do: "spawn", what: { label: name }, place: at };
    }
    const net = this.getNet();
    const design = this.modelAvailable && !!net?.connected && typeof net.design === "function";
    const result = this.exec([{ do: "remove", target: { id: prev.id } }, spawn], { label: `it's ${name}`, source: "correction", decorate, design, hint: `it's ${name}` });
    const added = result.ops.find((op) => op.t === "add");
    if (added) this.lastRealized = { ...this.lastRealized, id: added.obj.id, guess: name };
    // Without the model, unknown names become a labelled crate; say so instead of pretending.
    this.reply(result.say.length ? result.say.join(" ") : `Oh, ${withArticle(name)}! My mistake.`, "correction");
    return result;
  }

  // A missing thing: the placeholder is already in the room; the design replaces it when it arrives.
  queueDesign(record, hint, entry) {
    const name = String(record.data?.designing || record.label || "thing");
    this.pending.add(record.id);
    this.designs = this.designs
      .then(() => this.designOne(record.id, name, hint, entry))
      .catch((err) => console.warn("[runner] design failed", err))
      .finally(() => this.pending.delete(record.id));
    return this.designs;
  }

  // Markers nobody is designing (undo of "clear", or the device that asked reloaded or closed
  // mid-design): this device takes over its own at once, anyone's after ORPHAN_MS. → how many.
  adoptDesigns(now = Date.now()) {
    const net = this.getNet();
    if (!this.modelAvailable || !net?.connected || typeof net.design !== "function") return 0;
    let adopted = 0;
    for (const record of this.room.records()) {
      if (record.part !== DESIGNING || this.pending.has(record.id)) continue;
      if (record.by !== this.getUser() && now - (record.t || 0) < ORPHAN_MS) continue;
      this.queueDesign(record, record.label || "", null);
      adopted++;
    }
    return adopted;
  }

  // One model call finished: the "thinking" effect stops when none is left.
  idle() {
    this.busy = Math.max(0, this.busy - 1);
    if (!this.busy) this.emit("done", {});
  }

  async designOne(id, name, hint, entry) {
    if (!this.room.get(id)) return; // removed (or undone) before its turn
    const net = this.getNet();
    let blueprint = null;
    let line = "";
    let failure = "";
    const known = getMeta(name);
    // Designed meanwhile (same thing asked twice): reuse it instead of asking again.
    const learned = known && this.learned.get(known.name);
    if (learned) blueprint = learned;
    else {
      this.busy++;
      this.emit("designing", { name });
      try {
        const result = await net.design(name, hint);
        const res = normalizeBlueprint({ ...result.blueprint, name });
        if (res.ok) {
          blueprint = res.blueprint;
          line = String(result.say || "");
        } else failure = res.error;
      } catch (err) {
        failure = err.code || err.message || "no answer";
      } finally {
        this.idle();
      }
    }
    const current = this.room.get(id);
    if (!current || current.part !== DESIGNING) return;
    if (!blueprint) {
      // Truthful fallback: a labelled crate, and a way to try again.
      this.replacePlaceholder(current, { part: `custom:${slug(name)}`.slice(0, 80), label: name, data: { unknown: true } }, entry);
      this.reply(`I couldn't design ${withArticle(name)} this time (${failure}). Say it again and I'll try once more.`, "design");
      return;
    }
    this.learnBlueprint(blueprint);
    this.learned.set(blueprint.name, blueprint);
    const holdable = blueprint.holdable && Math.max(...blueprint.size) <= 2;
    const swap = { part: `custom:${slug(name)}`.slice(0, 80), label: name, data: { blueprint } };
    if (current.attach && !holdable) {
      // Too big for a hand after all: it lands in front of the player instead.
      this.replacePlaceholder(current, swap, entry, { detach: true });
      this.reply(`${capital(withArticle(name))} is too big to hold, so it's in front of you.`, "design");
    } else {
      this.replacePlaceholder(current, swap, entry);
      this.reply(line || `${capital(withArticle(name))}, made just for you.`, "design");
    }
  }

  // Turns the placeholder into its real thing in place: the same id, so "it", things stacked on it
  // and undo of edits made to the marker keep working; "undo" removes it with the original spawn.
  replacePlaceholder(record, swap, entry, { detach = false } = {}) {
    const { designing, ...kept } = record.data || {};
    const patch = { part: swap.part, label: swap.label, data: { ...kept, ...swap.data } };
    const after = { ...record, ...patch };
    const size = sizeOfRecord(after);
    const pose = this.getPlayer();
    const head = Array.isArray(pose.p) ? pose.p : [0, 1.6, 0];
    const p0 = Array.isArray(record.p) ? record.p : [0, 0, 0];
    const onGround = (p0[1] || 0) < 0.05 && Math.hypot(p0[0] - head[0], p0[2] - head[2]) < 100;
    if (detach || (onGround && !record.attach && !record.onto)) {
      // The real thing is bigger than its 0.4 m marker: the same spot, but never on top of the
      // player or other things (a pirate ship asked for "in front of me").
      const spot = resolvePlacement(detach ? { rel: "front" } : { rel: "here" }, {
        player: detach ? pose : { ...pose, aim: p0, aimHere: true }, size,
        records: this.room.records(), sizeOf: (r) => sizeOfRecord(r), exclude: [record.id],
      });
      patch.p = spot.p;
      patch.ry = spot.ry;
      if (detach) patch.attach = null;
    }
    const ops = [{ t: "set", id: record.id, patch, uid: makeId("u") }];
    // Things standing on the marker move along and stand on the real thing's top.
    if (!record.attach) {
      const p1 = patch.p || p0;
      const delta = [p1[0] - p0[0], p1[1] + size[1] - (p0[1] + sizeOfRecord(record)[1]), p1[2] - p0[2]];
      const above = new Set([record.id]);
      for (let grew = true; grew;) {
        grew = false;
        for (const r of this.room.records()) {
          if (above.has(r.id) || !r.onto || !above.has(r.onto) || r.attach || !Array.isArray(r.p)) continue;
          above.add(r.id);
          grew = true;
          ops.push({ t: "set", id: r.id, patch: { p: r.p.map((n, i) => Math.round((n + delta[i]) * 1000) / 1000) }, uid: makeId("u") });
        }
      }
    }
    const inverse = [];
    for (const op of ops) {
      inverse.unshift(...this.room.inverse(op));
      this.send(op);
    }
    if (entry && this.history.includes(entry)) entry.inverse.unshift(...inverse);
    else {
      this.history.push({ label: `design ${swap.label}`, inverse });
      if (this.history.length > HISTORY_LIMIT) this.history.shift();
    }
  }

  // Sends raw ops with undo support; merge = fold into the previous history entry.
  sendTracked(ops, label, merge = false) {
    const inverse = [];
    for (const op of ops) {
      op.uid = op.uid || makeId("u");
      inverse.unshift(...this.room.inverse(op));
      this.send(op);
    }
    if (merge && this.history.length) this.history[this.history.length - 1].inverse.unshift(...inverse);
    else {
      this.history.push({ label, inverse });
      if (this.history.length > HISTORY_LIMIT) this.history.shift();
    }
  }

  undo(count = 1) {
    let undone = 0;
    for (let i = 0; i < count && this.history.length; i++) {
      const entry = this.history.pop();
      for (const op of entry.inverse) this.send({ ...op, uid: makeId("u") });
      undone++;
    }
    this.reply(undone ? `Undid ${undone === 1 ? "that" : `${undone} steps`}.` : "Nothing to undo.", "system", { speak: false });
    return undone;
  }

  // "it"/"last" mean the last thing THIS device touched, even when acting for the headset player.
  resolveRefs(intent) {
    const lastId = this.lastIds.find((id) => this.room.get(id));
    if (!lastId) return intent;
    const fix = (target) => (target && (target.ref === "it" || target.ref === "last") ? { id: lastId } : target);
    const copy = { ...intent };
    if (copy.target) copy.target = fix(copy.target);
    if (copy.place?.ref) copy.place = { ...copy.place, ref: fix(copy.place.ref) };
    return copy;
  }

  // Model-made blueprints become reusable parts here and in the laptop parts bin.
  learnBlueprint(blueprint) {
    const name = String(blueprint.name || "").toLowerCase();
    if (!name || getMeta(name)) return;
    registerMeta({ name, aliases: blueprint.aliases || [], desc: blueprint.desc || "made by the model", size: blueprint.size, holdable: !!blueprint.holdable, grip: blueprint.grip, category: "custom" });
    registerBuilder(name, (opts) => buildBlueprint(blueprint, opts));
    this.getNet()?.saveBlueprint?.(blueprint).catch((err) => console.warn("[runner] could not save blueprint", err));
    this.emit("parts-changed");
  }

  // Blueprint data of an existing custom record (so held/size checks work for model-made parts).
  recordData(part) {
    for (const record of this.room.records()) if (record.part === part && record.data?.blueprint) return record.data;
    return undefined;
  }

  reply(text, source, { speak = true } = {}) {
    this.emit("reply", { text, source, speak });
  }
}

function capital(text) {
  const t = String(text || "");
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

function describe(ops) {
  const added = ops.filter((op) => op.t === "add").map((op) => op.obj.label || op.obj.part);
  if (added.length) return `Summoned ${added.length > 3 ? `${added.length} things` : added.join(", ")}.`;
  if (ops.some((op) => op.t === "del")) return "Removed.";
  if (ops.some((op) => op.t === "clear")) return "Cleared the field.";
  if (ops.some((op) => op.t === "env")) return "Changing the sky.";
  return "Done.";
}
