// Procedural hand visuals: a Quest Touch-style controller (grip space), a pointer laser and a
// simple glove for tracked hands, desktop views and avatars. Geometry/materials are shared.
import * as THREE from "../../vendor/three.module.min.js";

const DEG = Math.PI / 180;
const COLORS = { body: "#2c312d", face: "#1b201c", button: "#454c46", accent: "#d5fb6a", glove: "#a7b0a4", cuff: "#19271b" };

let shared = null;

function markShared(list) {
  for (const item of list) item.userData.shared = true;
}

function assets() {
  if (shared) return shared;
  const std = (color, roughness) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.05 });
  const mats = {
    body: std(COLORS.body, 0.55),
    face: std(COLORS.face, 0.4),
    button: std(COLORS.button, 0.5),
    glove: std(COLORS.glove, 0.85),
    cuff: std(COLORS.cuff, 0.8),
    accent: new THREE.MeshBasicMaterial({ color: COLORS.accent }),
    beam: new THREE.MeshBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.5, depthWrite: false }),
    dot: new THREE.MeshBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.95, depthWrite: false }),
  };
  const beam = new THREE.CylinderGeometry(0.0016, 0.0016, 1, 6, 1, true);
  beam.rotateX(-Math.PI / 2); // cylinder axis Y → Z
  beam.translate(0, 0, -0.5); // spans z = 0 to -1, scaled per length
  const geos = {
    handle: new THREE.CapsuleGeometry(0.019, 0.07, 4, 10),
    head: new THREE.CylinderGeometry(0.035, 0.031, 0.022, 20),
    rim: new THREE.TorusGeometry(0.034, 0.0025, 4, 28),
    ring: new THREE.TorusGeometry(0.047, 0.0065, 6, 28),
    stick: new THREE.CylinderGeometry(0.004, 0.005, 0.012, 8),
    cap: new THREE.CylinderGeometry(0.0095, 0.0095, 0.004, 14),
    button: new THREE.CylinderGeometry(0.0058, 0.0058, 0.004, 12),
    trigger: new THREE.BoxGeometry(0.014, 0.012, 0.03),
    squeeze: new THREE.BoxGeometry(0.008, 0.026, 0.034),
    beam,
    dot: new THREE.SphereGeometry(0.011, 10, 8),
    palm: new THREE.BoxGeometry(0.03, 0.09, 0.085),
    finger: new THREE.TorusGeometry(0.024, 0.0095, 6, 10, Math.PI * 1.35),
    thumb: new THREE.CapsuleGeometry(0.0105, 0.04, 3, 8),
    cuffGeo: new THREE.CylinderGeometry(0.034, 0.036, 0.03, 14),
  };
  markShared(Object.values(mats));
  markShared(Object.values(geos));
  shared = { mats, geos };
  return shared;
}

const noRaycast = () => {};

function mesh(geometry, material, p, r) {
  const m = new THREE.Mesh(geometry, material);
  if (p) m.position.set(p[0], p[1], p[2]);
  if (r) m.rotation.set(r[0] * DEG, r[1] * DEG, r[2] * DEG);
  m.raycast = noRaycast; // never block HUD/object picking
  return m;
}

// Touch-style controller in WebXR grip space: the handle runs along Z (bottom at +Z, face at -Z),
// the face tilts 45 degrees toward the user, the trigger sits on the -Y (forward) side.
export function makeControllerModel(handedness = "right") {
  const { mats, geos } = assets();
  const side = handedness === "left" ? -1 : 1;
  const root = new THREE.Group();
  root.name = `controller-${handedness}`;

  root.add(mesh(geos.handle, mats.body, [0, 0.004, 0.014], [90, 0, 0]));
  root.add(mesh(geos.trigger, mats.button, [0, -0.021, -0.03], [-12, 0, 0]));
  root.add(mesh(geos.squeeze, mats.button, [-0.018 * side, -0.004, 0.006]));

  // Face: local +Y is the face normal, -Z points forward along the pointer ray.
  const head = new THREE.Group();
  head.position.set(0, 0.012, -0.056);
  head.rotation.x = -45 * DEG;
  head.add(mesh(geos.head, mats.face, [0, 0, 0]));
  head.add(mesh(geos.rim, mats.accent, [0, 0.0112, 0], [90, 0, 0]));
  head.add(mesh(geos.stick, mats.button, [-0.011 * side, 0.016, 0.006]));
  head.add(mesh(geos.cap, mats.accent, [-0.011 * side, 0.023, 0.006]));
  head.add(mesh(geos.button, mats.button, [0.014 * side, 0.0125, 0.009]));
  head.add(mesh(geos.button, mats.button, [0.009 * side, 0.0125, -0.009]));
  // Tracking ring arching over the front of the face.
  head.add(mesh(geos.ring, mats.body, [0.004 * side, 0.03, -0.012], [18, 0, 0]));
  root.add(head);

  root.userData.handedness = handedness;
  return root;
}

// Pointer laser along -Z with a hit dot at the end. userData.setLength(meters) resizes it.
export function makeLaser() {
  const { mats, geos } = assets();
  const root = new THREE.Group();
  root.name = "laser";
  const beam = mesh(geos.beam, mats.beam);
  const dot = mesh(geos.dot, mats.dot);
  beam.renderOrder = 2;
  dot.renderOrder = 3;
  root.add(beam, dot);
  root.userData.beam = beam;
  root.userData.dot = dot;
  root.userData.setLength = (length) => {
    const len = Math.max(0.05, Number(length) || 0);
    beam.scale.set(1, 1, len);
    dot.position.set(0, 0, -len);
  };
  root.userData.setLength(5);
  return root;
}

// Simple glove in grip space (fist around a rod along Z); the back of the right hand faces +X.
export function makeHandProxy(handedness = "right") {
  const { mats, geos } = assets();
  const side = handedness === "left" ? -1 : 1;
  const root = new THREE.Group();
  root.name = `hand-${handedness}`;
  root.add(mesh(geos.palm, mats.glove, [0.034 * side, 0.03, 0.002]));
  // Curled fingers: partial tori around the rod, centred on the palm-facing side (-X for the right hand).
  for (let i = 0; i < 4; i++) {
    const finger = mesh(geos.finger, mats.glove, [0, 0, -0.03 + i * 0.02]);
    finger.rotation.z = side > 0 ? 0.325 * Math.PI : -0.675 * Math.PI;
    finger.scale.setScalar(1 - i * 0.06);
    root.add(finger);
  }
  root.add(mesh(geos.thumb, mats.glove, [0.012 * side, -0.02, -0.046], [90, 0, -20 * side]));
  root.add(mesh(geos.cuffGeo, mats.cuff, [0.03 * side, 0.085, 0.002]));
  root.add(mesh(geos.rim, mats.accent, [0.03 * side, 0.1, 0.002], [90, 0, 0]));
  root.userData.handedness = handedness;
  return root;
}
