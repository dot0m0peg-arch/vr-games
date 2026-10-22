// VR HUD in Node with a stand-in 2D canvas: pointing at menu buttons must not redraw the menu.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../vendor/three.module.min.js";

const ctx = new Proxy({}, {
  get: (target, key) => (key in target ? target[key] : key === "measureText" ? (t) => ({ width: String(t).length * 10 }) : () => ctx),
  set: (target, key, value) => ((target[key] = value), true),
});
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
const { Hud } = await import("../js/ui/hud.js");

test("menu hover moves an overlay instead of redrawing and re-uploading the menu canvas", () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1.6, 0);
  scene.add(camera);
  scene.updateMatrixWorld(true);
  const hud = new Hud({ scene, camera });
  hud.toggleMenu(true);
  hud.update(0.016);
  scene.updateMatrixWorld(true);
  const texture = hud.menu.texture;
  const version = texture.version;
  const { width: W, height: H } = hud.menu.mesh.geometry.parameters;
  const px = W / hud.menu.canvas.width;
  const local = (x, y) => new THREE.Vector3(x * px - W / 2, H / 2 - y * px, 0);
  const center = (b) => local(b.x + b.w / 2, b.y + b.h / 2);
  const ray = new THREE.Raycaster();
  const aim = (point) => {
    const head = camera.getWorldPosition(new THREE.Vector3());
    const target = hud.menu.mesh.localToWorld(point.clone());
    ray.set(head, target.sub(head).normalize());
    const on = hud.hover(ray);
    hud.update(0.016);
    scene.updateMatrixWorld(true);
    return on;
  };
  const button = (id) => hud._buttons.find((b) => b.id === id);

  assert.ok(aim(center(button("undo"))), "the ray is on the menu");
  assert.ok(hud.menuHover.visible && hud.hoverFill.visible, "plain button: border and lifted fill");
  assert.ok(hud.menuHover.position.distanceTo(center(button("undo")).setZ(0.001)) < 1e-6, "overlay sits on the button");
  aim(center(button("parts")));
  assert.ok(hud.menuHover.visible && !hud.hoverFill.visible, "primary button: border only");
  const gap = button("undo");
  aim(local(gap.x + gap.w + 8, gap.y + gap.h / 2)); // between Undo and Clear
  assert.ok(!hud.menuHover.visible, "no button under the ray");
  assert.equal(texture.version, version, "hovering never re-uploads the menu canvas");

  // A click still redraws (state change) and keeps the overlay on the hovered button.
  aim(center(button("time")));
  assert.ok(hud.click(ray));
  hud.update(0.016);
  assert.ok(texture.version > version, "pressing redraws");
  assert.ok(hud.menuHover.visible);
  hud.toggleMenu(false);
  assert.ok(!hud.menuHover.visible);
});
