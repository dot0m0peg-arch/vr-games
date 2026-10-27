// dot3d event bus: games emit what happened (contact, break, footstep, dig, spawn), effects listen.
// Claude (Command), Oct 25 2026.
export function createBus() {
  const handlers = new Map();
  return {
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type)?.delete(fn);
    },
    emit(type, payload) {
      const set = handlers.get(type);
      if (!set) return 0;
      for (const fn of [...set]) fn(payload);
      return set.size;
    },
    clear() { handlers.clear(); },
  };
}
