// Bounded nearest-light rig. Field owns the decoration, so it cannot change a part's bounds or colliders.
// Codex (Command).
import * as THREE from '../../vendor/three.module.min.js';
import { createGroundGlow } from '../dot3d/decals.js';

export function fireFlicker(t) {
  return 1 + 0.18 * Math.sin(t * Math.PI * 14) + 0.07 * Math.sin(t * Math.PI * 4.6);
}

export class LocalLights {
  constructor(scene, budget) {
    this.scene = scene;
    this.budget = budget;
    this.entries = new Map();
    this.position = new THREE.Vector3();
    this.group = new THREE.Group();
    this.group.name = 'field-local-glows';
    scene.add(this.group);
    this.haloMap = null;
  }
  // night: 0 by day, 1 at night (the field passes it from its sun). A light whose fieldLight says `night: true` (the
  // blacksmith's forge, step 12) scales with it and, while it would be dark, does not take one of the tier's slots.
  update(player, t, night = 0) {
    const found = [];
    this.scene.updateMatrixWorld(true);
    this.scene.traverse(o => {
      if (!o.isPointLight || !o.userData.fieldLight) return;
      let p = o.parent;
      while (p && p.visible) p = p.parent;
      if (p) { o.visible = false; return; }
      if (o.userData.fieldLight.night && !(night > 0.05)) { o.visible = false; o.intensity = 0; return; }
      o.getWorldPosition(this.position);
      found.push({ light: o, distance: this.position.distanceToSquared(player) });
    });
    const attached = new Set(found.map(e => e.light));
    for (const [light, e] of this.entries) if (!attached.has(light)) {
      this.group.remove(e.glow, e.halo);
      e.glow.geometry.dispose(); e.glow.material.dispose(); e.halo?.material.dispose();
      this.entries.delete(light);
    }
    found.sort((a, b) => a.distance - b.distance || a.light.id - b.light.id);
    found.forEach(({ light }, i) => {
      const def = light.userData.fieldLight;
      light.visible = i < this.budget;
      light.castShadow = false;
      light.intensity = def.intensity * (def.fire ? fireFlicker(t + def.phase) : 1) * (def.night ? Math.min(1, night) : 1);
      let e = this.entries.get(light);
      if (!e) {
        const glow = createGroundGlow(THREE, { size: def.fire ? 2 : 3, color: light.color });
        let halo = null;
        if (!def.fire) {
          if (!this.haloMap) {
            const n = 64, data = new Uint8Array(n * n * 4);
            for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
              const k = (y * n + x) * 4, r = Math.hypot((x + .5) / n * 2 - 1, (y + .5) / n * 2 - 1);
              data.set([255, 255, 255, Math.round(255 * Math.max(0, 1 - r) ** 3)], k);
            }
            this.haloMap = new THREE.DataTexture(data, n, n); this.haloMap.needsUpdate = true;
          }
          halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.haloMap, color: light.color, opacity: .3,
            blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
          halo.scale.set(2.2, 2.2, 1); halo.raycast = () => {};
          this.group.add(halo);
        }
        e = { glow, halo }; this.entries.set(light, e); this.group.add(glow);
      }
      light.getWorldPosition(this.position);
      e.glow.position.set(this.position.x, .015, this.position.z);
      e.glow.visible = light.visible;
      e.glow.material.uniforms.opacity.value = .24 * (def.fire ? fireFlicker(t + def.phase) : 1);
      if (e.halo) { e.halo.position.copy(this.position); e.halo.visible = light.visible; }
    });
  }
  dispose() {
    for (const e of this.entries.values()) {
      e.glow.geometry.dispose(); e.glow.material.dispose(); e.halo?.material.dispose();
    }
    this.haloMap?.dispose(); this.entries.clear(); this.scene.remove(this.group);
  }
}

// Analytic height fog on existing surfaces: optical distance through the 0-1.5m slab, zero extra draws.
// A material is patched once and stays patched (WeakSet: retired materials are not kept alive), so update() may be
// called with the whole scene each frame or with any sub-tree (the phaser prepares its clones this way) without
// re-keying anything already compiled. Idle density 0 draws nothing. Claude (Command), step 5.
export function createDawnMist() {
  const group = new THREE.Group(); group.name = 'field-dawn-mist';
  const uniforms = { density: { value: 0 }, color: { value: new THREE.Color('#d9a8b4') } };
  const patched = new WeakSet();
  const fog = `
    float dy = vDawnWorld.y - cameraPosition.y;
    float inside;
    if (abs(dy) < .0001) inside = step(0., cameraPosition.y) * step(cameraPosition.y, 1.5);
    else {
      float a = (0. - cameraPosition.y) / dy, b = (1.5 - cameraPosition.y) / dy;
      inside = max(0., min(1., max(a,b)) - max(0., min(a,b)));
    }
    float opticalDepth = length(vDawnWorld - cameraPosition) * inside * dawnDensity;
    gl_FragColor.rgb = mix(gl_FragColor.rgb, dawnColor, 1. - exp(-opticalDepth));
  `;
  function update(scene) {
    scene.traverse(o => {
      for (const material of o.material ? [o.material].flat() : []) {
        if (patched.has(material)) continue;
        const custom = ['field-grass', 'field-clumps', 'field-flowers'].includes(material.name);
        if (!custom && !material.isMeshStandardMaterial && !material.isMeshLambertMaterial) continue;
        const original = material.onBeforeCompile, key = material.customProgramCacheKey;
        function compile(shader, renderer) {
          original.call(this, shader, renderer);
          // A phaser clone of a patched material already carries the fog through its original's compile: patch once.
          if (shader.vertexShader.includes('varying vec3 vDawnWorld;')) return;
          Object.assign(shader.uniforms, { dawnDensity: uniforms.density, dawnColor: uniforms.color });
          shader.vertexShader = 'varying vec3 vDawnWorld;\n' + shader.vertexShader;
          if (custom) shader.vertexShader = shader.vertexShader.replace('gl_Position = projectionMatrix * mvPosition;',
            'vDawnWorld = world; gl_Position = projectionMatrix * mvPosition;');
          else shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
            #include <project_vertex>
            vec4 dawnLocal = vec4(transformed, 1.);
            #ifdef USE_INSTANCING
              dawnLocal = instanceMatrix * dawnLocal;
            #endif
            vDawnWorld = (modelMatrix * dawnLocal).xyz;
          `);
          shader.fragmentShader = 'varying vec3 vDawnWorld; uniform float dawnDensity; uniform vec3 dawnColor;\n' + shader.fragmentShader;
          shader.fragmentShader = shader.fragmentShader.replace('#include <tonemapping_fragment>', fog + '\n#include <tonemapping_fragment>');
        }
        patched.add(material);
        material.onBeforeCompile = compile;
        material.customProgramCacheKey = function() { return key.call(this) + '|dawn-height-fog-v1'; };
        material.needsUpdate = true;
      }
    });
  }
  function dispose() {
    uniforms.density.value = 0; // patched materials keep a harmless zero-density fog
  }
  return { group, uniforms, update, dispose };
}
