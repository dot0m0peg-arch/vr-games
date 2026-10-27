// Articulated hand for the physics candidate. Claude (Command), Oct 25 2026.
// A palm, four three-segment fingers and a two-segment thumb in WebXR grip space, the frame xr/hands.js uses: the
// controller handle runs along Z, the back of the right hand faces +X and the fingers wrap toward -X (mirrored in X for
// the left hand). A pose is five curls 0..1 (thumb, index, middle, ring, pinky). The same joint math builds the visual
// hierarchy (jointRotations) and the sample points the fit tests against the held body (chain), so what the fingers
// stop on is what the player sees.
import * as THREE from '../../vendor/three.module.min.js';

export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
export const REST = 0.12; // a relaxed hand is never flat
const DEG = Math.PI / 180;
// Segment lengths and radii (metres), knuckle z, splay about X when open (degrees), bend per joint at full curl (degrees).
const SEG = { index: [.045, .028, .022], middle: [.05, .03, .024], ring: [.045, .028, .022], pinky: [.035, .022, .018], thumb: [.042, .032] };
const RAD = { index: [.0092, .0084, .0076], middle: [.0095, .0087, .0078], ring: [.009, .0082, .0074], pinky: [.008, .0073, .0066], thumb: [.011, .0098] };
const KNUCKLE_Z = { index: -.03, middle: -.01, ring: .01, pinky: .03 };
const SPLAY = { index: -7, middle: -2, ring: 2.5, pinky: 7 };
const BEND = { finger: [80, 100, 70], thumb: [0, 65] };
const PALM_X = .033, KNUCKLE_Y = -.012;
const THUMB_ROOT = [.028, .03, -.034];
// Thumb directions (right hand; X mirrored for the left): open points forward past the controller face, closed folds
// across the palm toward the fingers.
const THUMB_OPEN = new THREE.Vector3(-.25, -.35, -.9).normalize();
const THUMB_CLOSED = new THREE.Vector3(-.85, -.45, -.3).normalize();
const Z = new THREE.Vector3(0, 0, 1), X = new THREE.Vector3(1, 0, 0);
const sideOf = handedness => handedness === 'left' ? -1 : 1;
const clamp01 = v => Math.min(1, Math.max(0, +v || 0));

// Rotation whose local -Y points along `dir` and whose local -X*side (the bend direction) points along `toward`.
function aim(dir, toward, side) {
  const y = dir.clone().multiplyScalar(-1).normalize();
  const x = toward.clone().addScaledVector(y, -toward.dot(y)).normalize().multiplyScalar(-side);
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
const thumbBase = (() => {
  const cache = {};
  return side => cache[side] ??= (() => {
    const open = THUMB_OPEN.clone(), closed = THUMB_CLOSED.clone();
    open.x *= side; closed.x *= side;
    const toward = closed.clone().sub(open).normalize();
    return { open: aim(open, toward, side), closed: aim(closed, toward, side) };
  })();
})();

// Root position and the rotation of every joint (each local to its parent) for one finger at `curl`.
export function jointRotations(name, curl, handedness = 'right') {
  const side = sideOf(handedness), c = clamp01(curl);
  if (name === 'thumb') {
    const base = thumbBase(side);
    const q0 = base.open.clone().slerp(base.closed, c);
    const q1 = new THREE.Quaternion().setFromAxisAngle(Z, -side * BEND.thumb[1] * DEG * c);
    return { root: new THREE.Vector3(THUMB_ROOT[0] * side, THUMB_ROOT[1], THUMB_ROOT[2]), rotations: [q0, q1] };
  }
  const splay = new THREE.Quaternion().setFromAxisAngle(X, SPLAY[name] * DEG * (1 - c));
  const rotations = BEND.finger.map((deg, i) => {
    const q = new THREE.Quaternion().setFromAxisAngle(Z, -side * deg * DEG * c);
    return i === 0 ? splay.multiply(q) : q;
  });
  return { root: new THREE.Vector3(PALM_X * side, KNUCKLE_Y, KNUCKLE_Z[name]), rotations };
}

// Sample points of one finger in hand space at `curl`: each joint after the knuckle, the middle of each segment and the
// tip, with the finger radius there. The knuckle itself sits in the palm and is not a sample.
export function chain(name, curl, handedness = 'right') {
  const { root, rotations } = jointRotations(name, curl, handedness);
  const out = [];
  const p = root.clone(), q = new THREE.Quaternion();
  const segs = SEG[name], rads = RAD[name];
  for (let i = 0; i < segs.length; i++) {
    q.multiply(rotations[i]);
    const step = new THREE.Vector3(0, -segs[i], 0).applyQuaternion(q);
    out.push({ p: p.clone().addScaledVector(step, .5), r: rads[i] });
    p.add(step);
    out.push({ p: p.clone(), r: rads[i] * (i === segs.length - 1 ? .9 : 1) });
  }
  return out;
}

// Curl targets from controller input {trigger 0..1, squeeze 0..1, thumb: resting on the face buttons}. Nothing pressed
// is a relaxed open hand with the thumb up; squeeze alone points; squeeze and trigger make a fist. A hand holding
// something closes fully (the fit then stops each finger on the thing it holds).
export function targetCurls(input, holding = false) {
  if (holding) return [1, 1, 1, 1, 1];
  const t = clamp01(input?.trigger), s = clamp01(input?.squeeze);
  const f = v => REST + (1 - REST) * v;
  return [input?.thumb ? 1 : REST, f(t), f(s), f(s), f(s)];
}

// Close each finger no further than the held body allows. margin(localPoint, radius) is how far a hand-space sample
// point of that radius is from pressing into the held body (negative: it does). A finger free at its target stays
// there; otherwise it scans down in eighths to the nearest free curl and bisects up to the contact (1/1024); a finger
// blocked at every curl (a thumb across a sword guard) takes the curl that presses in least.
const SCAN = 8, SPLIT = 7;
export function fitCurls(targets, handedness, margin) {
  const worst = (name, c) => { let m = Infinity; for (const s of chain(name, c, handedness)) m = Math.min(m, margin(s.p, s.r)); return m; };
  return FINGERS.map((name, i) => {
    const target = clamp01(targets[i]);
    if (worst(name, target) >= 0) return target;
    let best = { c: target, m: -Infinity }, lo = -1;
    for (let k = SCAN - 1; k >= 0; k--) {
      const c = target * k / SCAN, m = worst(name, c);
      if (m >= 0) { lo = c; break; }
      if (m > best.m) best = { c, m };
    }
    if (lo < 0) return best.c;
    let hi = lo + target / SCAN;
    for (let k = 0; k < SPLIT; k++) { const mid = (lo + hi) / 2; if (worst(name, mid) >= 0) lo = mid; else hi = mid; }
    return lo;
  });
}

// ---------- visuals ----------
const COLORS = { glove: '#a7b0a4', cuff: '#19271b', accent: '#d5fb6a' };
const geometries = new Map(), materials = new Map();
const geometry = (key, make) => { let g = geometries.get(key); if (!g) { g = make(); g.userData.shared = true; geometries.set(key, g); } return g; };
function material(kind, opacity) {
  const key = kind + ':' + opacity;
  let m = materials.get(key);
  if (!m) {
    m = kind === 'accent' ? new THREE.MeshBasicMaterial({ color: COLORS.accent }) : new THREE.MeshStandardMaterial({ color: COLORS[kind], roughness: kind === 'cuff' ? .8 : .85, metalness: .05 });
    if (opacity < 1) { m.transparent = true; m.opacity = opacity; m.depthWrite = false; }
    m.userData.shared = true; materials.set(key, m);
  }
  return m;
}
const noRaycast = () => {};
function mesh(geo, mat) { const m = new THREE.Mesh(geo, mat); m.raycast = noRaycast; m.castShadow = true; return m; }
const capsule = (r, len) => geometry(`cap:${r}:${len}`, () => new THREE.CapsuleGeometry(r, len, 3, 8));

// A hand in grip space. root is the hand frame; setCurls([thumb, index, middle, ring, pinky]) poses it.
export function makeHandRig(handedness = 'right', { opacity = 1 } = {}) {
  const side = sideOf(handedness);
  const root = new THREE.Group();
  root.name = `physics-hand-${handedness}`;
  const glove = material('glove', opacity);
  const palm = mesh(geometry('palm', () => new THREE.CapsuleGeometry(.038, .04, 4, 12)), glove);
  palm.scale.set(.36, 1, 1); palm.position.set(PALM_X * side, .035, 0); palm.userData.part = 'palm';
  root.add(palm);
  const cuff = mesh(geometry('cuff', () => new THREE.CylinderGeometry(.034, .036, .03, 14)), material('cuff', opacity));
  cuff.scale.set(.5, 1, 1); cuff.position.set(PALM_X * side, .09, 0); cuff.userData.part = 'cuff';
  root.add(cuff);
  const rim = mesh(geometry('rim', () => new THREE.TorusGeometry(.034, .0025, 4, 28)), material('accent', opacity));
  rim.scale.set(.5, 1, 1); rim.position.set(PALM_X * side, .105, 0); rim.rotation.x = Math.PI / 2;
  root.add(rim);
  const fingers = {};
  for (const name of FINGERS) {
    const { root: at } = jointRotations(name, 0, handedness);
    const joints = [];
    let parent = root, pos = at;
    SEG[name].forEach((len, i) => {
      const joint = new THREE.Group();
      joint.name = `${name}-${i}`; joint.position.copy(pos);
      const seg = mesh(capsule(RAD[name][i], len), glove);
      seg.position.y = -len / 2; seg.userData.part = 'finger'; seg.userData.finger = name;
      joint.add(seg); parent.add(joint); joints.push(joint);
      parent = joint; pos = new THREE.Vector3(0, -len, 0);
    });
    fingers[name] = joints;
  }
  const curls = FINGERS.map(() => REST);
  function setCurls(next) {
    FINGERS.forEach((name, i) => {
      curls[i] = clamp01(next[i]);
      const { rotations } = jointRotations(name, curls[i], handedness);
      fingers[name].forEach((joint, j) => joint.quaternion.copy(rotations[j]));
    });
  }
  setCurls(curls);
  root.userData.handedness = handedness; root.userData.rig = true;
  return { root, fingers, curls, setCurls, dispose() { root.removeFromParent(); } };
}
