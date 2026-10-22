// Turns spoken or typed commands into room ops: local model (through the laptop bridge) or the
// built-in parser, then placement planning, undo history and spoken replies.
import { Emitter } from "./util/emitter.js";
import { makeId, rng } from "./util/ids.js";
import { stripWake } from "./core/wake.js";
import { parseCommand } from "./core/parse.js";
import { planIntents } from "./core/execute.js";
import { summarize } from "./core/room-state.js";
import { allMeta, getMeta, registerMeta } from "./parts/meta/index.js";
import { metaOfRecord, sizeOfRecord, registerBuilder } from "./parts/build/index.js";
import { buildBlueprint } from "./parts/build/blueprint.js";
import { matchPart, normalizeText } from "./core/lexicon.js";
import { classifySketch, projectStrokes, sketchBounds } from "./core/sketch.js";
import { WAKE_WORDS } from "./config.js";

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
    this.busy = 0;
  }

  async run(rawText, { source = "voice" } = {}) {
    const text = String(rawText || "").trim();
    if (!text) return null;
    const wake = stripWake(text, WAKE_WORDS);
    const command = (wake.matched ? wake.rest : text).trim();
    if (!command) {
      this.reply("Listening. Try: spawn a villa to my left.", "system", { speak: false });
      return null;
    }
    const hand = this.settings().hand || "right";
    const parsed = parseCommand(command, { metas: allMeta(), hand });
    const marker = parsed.intents.find((intent) => MARKER_INTENTS.has(intent.do));
    if (marker && parsed.confidence >= 0.8) return this.markerFlow(marker, command);
    const net = this.getNet();
    const useModel = this.modelAvailable && net?.connected && !(this.settings().fast && parsed.confidence >= 0.8);

    let intents = parsed.intents;
    let say = parsed.say ? [parsed.say] : [];
    let brain = "parser";
    if (useModel) {
      this.busy++;
      this.emit("thinking", { text: command });
      try {
        const player = this.getPlayer();
        const response = await net.command(command, {
          player,
          scene: summarize(this.room.state, player),
          parts: allMeta().filter((m) => m.source !== "builtin").map((m) => m.name),
        });
        intents = Array.isArray(response.intents) ? response.intents : [];
        say = response.say ? [response.say] : [];
        brain = response.model ? `model:${response.model}` : "model";
        if (!intents.length && parsed.intents.length && parsed.confidence >= 0.8) {
          intents = parsed.intents;
          say = parsed.say ? [parsed.say] : [];
          brain = "parser";
        }
      } catch (err) {
        console.warn("[runner] model failed, using parser", err);
        say = parsed.say ? [parsed.say] : [];
        if (!parsed.intents.length) say.push(`The local model did not answer (${err.code || err.message}).`);
      } finally {
        this.busy--;
        this.emit("done", {});
      }
    }
    if (!intents.length && !say.length) {
      say.push(parsed.unknown?.length
        ? `I don't know "${parsed.unknown.join(", ")}" yet. Try: spawn a crate in front of me.`
        : "I didn't catch a command. Try: spawn a villa to my left.");
    }
    const markerIntent = intents.find((intent) => MARKER_INTENTS.has(intent.do));
    if (markerIntent) return this.markerFlow(markerIntent, command);
    const result = this.exec(intents, { label: command, source: brain });
    const replies = [...say, ...result.say].filter(Boolean);
    if (replies.length) this.reply(replies.join(" "), brain);
    else if (result.ops.length) this.reply(describe(result.ops), brain, { speak: false });
    return { brain, ...result };
  }

  // Executes intents directly (UI buttons, HUD menu, model output). Returns { ops, say, errors }.
  exec(intents, { label = "", source = "ui", player = null, decorate = null } = {}) {
    const pose = player || this.getPlayer();
    const user = pose.user || this.getUser();
    intents = intents.map((intent) => this.resolveRefs(intent));
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
      this.history.push({ label, inverse });
      if (this.history.length > HISTORY_LIMIT) this.history.shift();
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
          this.busy--;
          this.emit("done", {});
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
        this.emit("thinking", { text: name });
        try {
          const response = await net.command(`spawn ${withArticle(name)}`, { player: this.getPlayer(), scene: [], parts: [] });
          const found = (response.intents || []).find((i) => i.do === "spawn");
          if (found) spawn = { ...found, place: at, count: 1 };
        } catch (err) {
          console.warn("[runner] correction model call failed", err);
        } finally {
          this.emit("done", {});
        }
      }
      if (!spawn) spawn = { do: "spawn", what: { label: name }, place: at };
    }
    const result = this.exec([{ do: "remove", target: { id: prev.id } }, spawn], { label: `it's ${name}`, source: "correction", decorate });
    const added = result.ops.find((op) => op.t === "add");
    if (added) this.lastRealized = { ...this.lastRealized, id: added.obj.id, guess: name };
    // Without the model, unknown names become a labelled crate; say so instead of pretending.
    this.reply(result.say.length ? result.say.join(" ") : `Oh, ${withArticle(name)}! My mistake.`, "correction");
    return result;
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

function describe(ops) {
  const added = ops.filter((op) => op.t === "add").map((op) => op.obj.label || op.obj.part);
  if (added.length) return `Summoned ${added.length > 3 ? `${added.length} things` : added.join(", ")}.`;
  if (ops.some((op) => op.t === "del")) return "Removed.";
  if (ops.some((op) => op.t === "clear")) return "Cleared the field.";
  if (ops.some((op) => op.t === "env")) return "Changing the sky.";
  return "Done.";
}
