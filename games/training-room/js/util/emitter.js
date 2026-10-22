// Tiny event emitter shared by browser modules and the Node bridge.
export class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (...args) => {
      off();
      fn(...args);
    });
    return off;
  }

  off(type, fn) {
    this._handlers.get(type)?.delete(fn);
  }

  emit(type, ...args) {
    for (const fn of [...(this._handlers.get(type) || [])]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[emitter] ${type} handler failed`, err);
      }
    }
  }
}
