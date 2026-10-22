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
import { WAKE_WORDS } from "./config.js";

const HISTORY_LIMIT = 60;

export class Runner extends Emitter {
  // send(op): applies locally and forwards to the bridge. getPlayer(): pose of whoever commands act for.
  constructor({ room, send, getNet, getPlayer, getUser, settings }) {
    super();
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
        if (err.code === "no-model") this.modelAvailable = false;
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
