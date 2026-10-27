// dot3d Rapier contact bridge: turns physics contact-force events into bus 'contact' events with the real world-space
// contact point, the normal out of the struck surface, the impulse (N*s) and the striker's approach velocity, so effects
// spawn where and as hard as things actually hit. Rapier (rapier3d-compat 0.21) is passed in. Claude (Command), Oct 25 2026.
//
// Impacts, not resting weight: a pair fires only when its contact force jumps (new contact, or a hit on top of an
// existing one). A block resting on the floor, or a stack, pushes a steady force every step and stays quiet.

export function createContactBridge(RAPIER, world, bus, opts = {}) {
  const queue = new RAPIER.EventQueue(true);
  const materials = new Map(); // collider handle -> 'metal' | 'wood' | 'soft' | 'stone' | 'paint'
  // collider handle -> the surface it was built from (the kit's look family: steel, iron, plank, bark, rock, straw, grass,
  // hand...). Rides beside the physics material on every event as `surfaces`, so effects can tell straw from leather and
  // grass from a stone floor without changing what the solver or the stick rule read. Step 6, Oct 26 2026.
  const surfaces = new Map();
  const minImpulse = opts.minImpulse ?? 0.05;
  const cooldown = opts.cooldown ?? 0.06; // seconds between events for the same pair
  const jump = opts.jump ?? 2;            // force must exceed jump x last step's force for the pair
  const pairs = new Map();                // pair key -> { f: last force, t: last seen, fired: last emit time }
  const preVel = new Map();               // body handle -> linvel before this step (approach velocity)
  let time = 0, emitted = 0, steps = 0;

  function register(collider, material = 'stone', threshold = opts.forceThreshold ?? 2, surface = null) {
    collider.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
    collider.setContactForceEventThreshold(threshold ?? opts.forceThreshold ?? 2);
    materials.set(collider.handle, material);
    surfaces.set(collider.handle, surface ? String(surface) : material);
    return collider;
  }
  function forget(collider) { materials.delete(collider.handle); surfaces.delete(collider.handle); }

  const ZERO = { x: 0, y: 0, z: 0 };
  const velOf = (body) => (body ? preVel.get(body.handle) ?? ZERO : ZERO);

  function step(dt = world.timestep) {
    world.timestep = dt;
    preVel.clear();
    world.forEachActiveRigidBody((b) => { const v = b.linvel(); preVel.set(b.handle, { x: v.x, y: v.y, z: v.z }); });
    world.step(queue);
    time += dt;
    const out = [];
    queue.drainContactForceEvents((ev) => {
      const h1 = ev.collider1(), h2 = ev.collider2();
      const key = h1 < h2 ? `${h1}:${h2}` : `${h2}:${h1}`;
      const f = ev.totalForceMagnitude();
      const p = pairs.get(key);
      const prevF = p && time - p.t <= dt * 1.5 ? p.f : 0;
      const entry = p ?? { f: 0, t: 0, fired: -1 };
      entry.f = f; entry.t = time; pairs.set(key, entry);
      const impulse = f * dt;
      if (impulse < minImpulse || f <= prevF * jump || time - entry.fired < cooldown) return;
      const c1 = world.getCollider(h1), c2 = world.getCollider(h2);
      if (!c1 || !c2) return;
      let point = null, n12 = null;
      world.contactPair(c1, c2, (manifold, flipped) => {
        if (point || manifold.numSolverContacts() === 0) return;
        const q = manifold.solverContactPoint(0), n = manifold.normal();
        const s = flipped ? -1 : 1; // n12 points from collider1 toward collider2
        point = { x: q.x, y: q.y, z: q.z }; n12 = { x: n.x * s, y: n.y * s, z: n.z * s };
      });
      if (!point) return;
      // The striker is the body that was moving faster before the step; the normal points out of the struck
      // surface toward it, and relVelocity is the striker's velocity relative to the struck body (into the surface).
      // striker: which of `colliders` that is (0 or 1), for a listener that needs the event seen from one side.
      const v1 = velOf(c1.parent()), v2 = velOf(c2.parent());
      const oneStrikes = Math.hypot(v1.x, v1.y, v1.z) >= Math.hypot(v2.x, v2.y, v2.z);
      const [vs, vt, sign] = oneStrikes ? [v1, v2, -1] : [v2, v1, 1];
      entry.fired = time;
      out.push({ point, normal: { x: n12.x * sign, y: n12.y * sign, z: n12.z * sign }, impulse,
        relVelocity: { x: vs.x - vt.x, y: vs.y - vt.y, z: vs.z - vt.z }, striker: oneStrikes ? 0 : 1,
        materials: [materials.get(h1) ?? 'stone', materials.get(h2) ?? 'stone'],
        surfaces: [surfaces.get(h1) ?? materials.get(h1) ?? 'stone', surfaces.get(h2) ?? materials.get(h2) ?? 'stone'], colliders: [h1, h2], time });
    });
    if (++steps % 120 === 0) for (const [k, e] of pairs) if (time - e.t > 1) pairs.delete(k);
    for (const e of out) { emitted++; bus.emit('contact', e); }
    return out;
  }

  return { step, register, forget, materialOf: (h) => materials.get(h), surfaceOf: (h) => surfaces.get(h) ?? materials.get(h),
    stats: () => ({ emitted, time, pairs: pairs.size }), dispose: () => queue.free() };
}

// Fixed-timestep driver with render interpolation, so physics is stable at any frame rate.
export function createFixedStep(stepFn, { hz = 60, maxSteps = 5 } = {}) {
  const dt = 1 / hz; let acc = 0;
  return {
    dt,
    advance(frameDt) {
      acc += Math.min(frameDt, dt * maxSteps);
      let n = 0;
      while (acc >= dt && n < maxSteps) { stepFn(dt); acc -= dt; n++; }
      return acc / dt; // alpha for interpolating render transforms
    },
  };
}
