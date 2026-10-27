// Client-side room: the shared room-state plus events for the 3D layer and UI.
import { Emitter } from "./util/emitter.js";
import { createState, applyOp, invertOp, loadState, snapshot } from "./core/room-state.js";

const SEEN_LIMIT = 2000;

export class Room extends Emitter {
  constructor() {
    super();
    this.state = createState();
    this.seen = new Set();
    this.seq = 0;
  }

  // Applies an op once (ops are deduplicated by uid so our own echoes from the bridge are ignored).
  apply(op, { local = false, seq = 0 } = {}) {
    if (op.uid) {
      if (this.seen.has(op.uid)) return false;
      this.seen.add(op.uid);
      if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value);
    }
    if (seq) this.seq = Math.max(this.seq, seq);
    const { events } = applyOp(this.state, op);
    for (const event of events) {
      if (event.type === "add") this.emit("add", event.record, op, { local });
      else if (event.type === "update") this.emit("update", event.record, event.patch, op, { local });
      else if (event.type === "remove") this.emit("remove", event.record, op, { local });
      else if (event.type === "clear") this.emit("clear", op, { local });
      else if (event.type === "env") this.emit("env", this.state.env.time, op, { local });
    }
    if (events.length) this.emit("change", op, { local });
    return events.length > 0;
  }

  // Ops that undo `op`; must be computed before applying it.
  inverse(op) {
    return invertOp(this.state, op);
  }

  load(json) {
    this.state = loadState(json);
    this.seen.clear();
    this.emit("load", this.state);
    this.emit("env", this.state.env.time, null, { local: false });
    this.emit("change", null, { local: false });
  }

  snapshot() {
    return snapshot(this.state);
  }

  get(id) {
    return this.state.objects[id];
  }

  records() {
    return this.state.order.map((id) => this.state.objects[id]).filter(Boolean);
  }
}
