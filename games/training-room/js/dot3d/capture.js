// dot3d capture rig: six fixed camera spots per game and an fps sampler, exposed on window.__dot3d so the
// capture tool (tools/capture.mjs) takes the same before/after shots every time. Claude (Command), Oct 25 2026.

export function createCaptureRig(THREE, { camera, spots, onGoto = null, controls = null }) {
  if (!Array.isArray(spots) || spots.length !== 6) throw new Error('dot3d capture: give exactly 6 fixed camera spots');
  const frames = [];
  let sampling = false, last = 0, current = -1;
  const target = new THREE.Vector3();
  const baseFov = camera.fov;

  function goto(i) {
    const s = spots[i];
    camera.position.set(...s.position);
    target.set(...s.target);
    camera.lookAt(target);
    const fov = s.fov ?? baseFov;
    if (fov !== undefined && camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    if (controls?.target) { controls.target.copy(target); controls.update?.(); }
    current = i;
    onGoto?.(i, s);
    return s.name;
  }

  // Call once per rendered frame (from the game's own loop) while sampling.
  function frame(now = performance.now()) {
    if (sampling && last) frames.push(now - last);
    last = now;
  }

  function stats() {
    if (!frames.length) return { frames: 0, fps: 0, p95ms: 0, worstms: 0 };
    const sorted = [...frames].sort((a, b) => a - b);
    const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
    return { frames: frames.length, fps: +(1000 / mean).toFixed(1), meanms: +mean.toFixed(2),
      p95ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2), worstms: +sorted[sorted.length - 1].toFixed(2) };
  }

  const api = {
    spots: spots.map((s) => s.name), current: () => current, goto, frame, stats,
    startSampling() { frames.length = 0; last = 0; sampling = true; },
    stopSampling() { sampling = false; return stats(); },
  };
  if (typeof window !== 'undefined') window.__dot3d = Object.assign(window.__dot3d ?? {}, api);
  return api;
}
