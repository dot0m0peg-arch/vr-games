// Contact hits, the player's side. The dot3d contact bridge (js/dot3d/contacts.js) already turns every real contact into
// a 'contact' bus event with the world-space point, the normal out of the struck surface, the impulse (N*s) and the two
// materials; decals.js leaves a scuff there sized by the impulse and particles.js sprays sparks, chips and dust by the
// materials. This module adds what the player feels and hears: the controller holding the striker (or the hand that struck)
// pulses, scaled by the impulse; a material thud, knock or clang plays through the existing Sfx at the contact point; and a
// 'hit' event {hand, id, impulse, intensity, ms, point, normal, materials, time} goes out on the same bus for the HUD and checks.
// Owner, Oct 23 2026 (Codex transmitter): "If I smack a wall with my sword, it should put an axe mark into the wall. It should
// do something ... The world should respond as the world would really respond." Claude (Command), Oct 26 2026.

export const HAPTIC_MIN_IMPULSE = 0.15; // N*s: below this a touch is not felt (a held sword settling on the floor)
export const SOUND_MIN_IMPULSE = 0.3;   // N*s: below this a touch makes no sound
const PULSE_GAP = 0.05;                 // s: one pulse per hand in this window; a harder hit inside it replaces the pulse
const SOUND_GAP = 0.06;                 // s: one sound per pair of bodies in this window (a crate landing on four corners, a
                                        // ten-collider sword on a wall: one hit each)

// Haptic pulse for an impulse. The impulse is what stops the hand AND what it carries (one rigid assembly through the
// hold joint, js/dot3d/physics.js drive) plus the hand's own push, so a held sword tapped on a wall at walking pace is
// about 3 N*s and a full swing 15-25 N*s: a tap is a nudge (~0.5), a swing is full.
export function hapticFor(impulse) {
  const i = +impulse || 0;
  if (!(i >= HAPTIC_MIN_IMPULSE)) return null;
  return { intensity: Math.min(1, 0.2 + 0.16 * Math.sqrt(i)), ms: Math.round(Math.min(120, 20 + 5 * i)) };
}

// core: the dot3d physics world (hands and props maps). sfx: an object with hit(point, {impulse, materials}) or null.
// haptic(hand, intensity, ms) -> boolean, or null. Returns {stats, dispose}.
export function createHitEffects({ bus, core, sfx = null, haptic = null }) {
  const stats = { contacts: 0, pulses: 0, sounds: 0, last: null, lastSound: null };
  const lastPulse = new Map(); // hand -> { t, intensity }
  const lastSound = new Map(); // body pair key -> t of its last sound
  // The pair of bodies behind a pair of collider handles (a collider removed mid-step falls back to its own handle).
  const bodyOf = (h) => core.world?.getCollider?.(h)?.parent()?.handle ?? h;
  const pairKey = (handles) => { const a = bodyOf(handles[0]), b = bodyOf(handles[1]); return a < b ? `${a}:${b}` : `${b}:${a}`; };

  // The hands a collider pair touches: a hand's own body, or the body a hand holds by its joint (both hands on a two-hand
  // hold). A hand still pulling something in is not holding it yet and feels nothing through it.
  function handsOn(handles) {
    const out = [];
    for (const [name, h] of core.hands) {
      let touched = handles.includes(h.body.collider(0)?.handle);
      if (!touched && h.joint && h.id) {
        const e = core.props.get(h.id);
        if (e) for (let i = 0; i < e.body.numColliders() && !touched; i++) touched = handles.includes(e.body.collider(i).handle);
      }
      if (touched) out.push(name);
    }
    return out;
  }

  // A blade biting into something and staying there is its own feel: a firm thunk in the hand (or hands) holding it, and
  // a shorter one when a tug works it free. The core raises 'stick' while it handles the contact, before this module sees
  // that contact, so a thunk from a contact waits and goes out right after the contact's own pulse (the last pulse sent
  // in a step is the one the controller keeps); a stick with no contact behind it (set from a record) thunks at once.
  const pendingThunk = new Map(); // hand -> time
  const thunk = (hand, t) => { if (haptic) haptic(hand, 0.9, 90); stats.pulses++; lastPulse.set(hand, { t, intensity: 0.9 }); };
  const offStick = bus.on('stick', (e) => {
    stats.sticks++;
    for (const hand of Array.isArray(e?.hands) ? e.hands : []) { if (e.impulse > 0) pendingThunk.set(hand, +e.time || 0); else thunk(hand, +e.time || 0); }
  });
  const offUnstick = bus.on('unstick', (e) => {
    stats.unsticks++;
    for (const hand of Array.isArray(e?.hands) ? e.hands : []) { if (haptic) haptic(hand, 0.55, 45); stats.pulses++; }
  });
  stats.sticks = 0; stats.unsticks = 0;

  const off = bus.on('contact', (e) => {
    onContact(e);
    if (pendingThunk.size) { for (const [hand, t] of pendingThunk) thunk(hand, t); pendingThunk.clear(); }
  });
  function onContact(e) {
    if (!e || !(e.impulse > 0)) return;
    stats.contacts++;
    const t = +e.time || 0;
    const handles = Array.isArray(e.colliders) ? e.colliders : [];
    const felt = hapticFor(e.impulse);
    if (felt) for (const hand of handsOn(handles)) {
      const prev = lastPulse.get(hand);
      if (prev && t - prev.t < PULSE_GAP && felt.intensity <= prev.intensity) continue;
      lastPulse.set(hand, { t, intensity: felt.intensity });
      const sent = haptic ? !!haptic(hand, felt.intensity, felt.ms) : false;
      stats.pulses++;
      stats.last = { hand, intensity: felt.intensity, ms: felt.ms, impulse: e.impulse, sent, time: t };
      bus.emit('hit', { hand, id: core.hands.get(hand)?.id ?? null, impulse: e.impulse, intensity: felt.intensity, ms: felt.ms,
        point: e.point, normal: e.normal, materials: e.materials, time: t });
    }
    if (sfx && e.impulse >= SOUND_MIN_IMPULSE && e.point && handles.length === 2) {
      const key = pairKey(handles), prev = lastSound.get(key);
      if (prev !== undefined && t - prev < SOUND_GAP) return;
      lastSound.set(key, t);
      if (lastSound.size > 64) for (const [k, pt] of lastSound) if (t - pt > 1) lastSound.delete(k);
      sfx.hit(e.point, { impulse: e.impulse, materials: e.materials });
      stats.sounds++;
      stats.lastSound = { impulse: e.impulse, materials: e.materials, point: { x: e.point.x, y: e.point.y, z: e.point.z }, time: t };
    }
  }

  return { stats: () => ({ ...stats }), handsOn, dispose() { off(); offStick(); offUnstick(); pendingThunk.clear(); lastPulse.clear(); lastSound.clear(); } };
}
