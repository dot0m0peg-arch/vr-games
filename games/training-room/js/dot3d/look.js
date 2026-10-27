// dot3d look: color pipeline, tone mapping, image-based environment light, one shadowed key light, height-free fog.
// Works with three r159 to r185 (THREE is passed in, never imported). Claude (Command), Oct 25 2026.
import { tierBudget } from './tiers.js';

export const revisionOf = (THREE) => parseInt(String(THREE.REVISION), 10) || 0;

// A small procedural "studio sky" scene rendered through PMREM: gradient dome plus soft light panels.
// It gives PBR materials real reflections and ambient light without an HDR file download.
export function makeEnvironmentScene(THREE, { sky = 0x9fb8d6, horizon = 0xe9dfcf, ground = 0x4a4138, sun = 0xfff1d6, sunDir = [0.5, 0.8, 0.3], panels = true } = {}) {
  const scene = new THREE.Scene();
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(50, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { uSky: { value: new THREE.Color(sky) }, uHorizon: { value: new THREE.Color(horizon) }, uGround: { value: new THREE.Color(ground) },
        uSun: { value: new THREE.Color(sun) }, uSunDir: { value: new THREE.Vector3(...sunDir).normalize() } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 uSky, uHorizon, uGround, uSun, uSunDir; varying vec3 vDir;
        void main(){ float h = vDir.y;
          vec3 c = h > 0.0 ? mix(uHorizon, uSky, pow(h, 0.6)) : mix(uHorizon, uGround, pow(-h, 0.4));
          float s = max(dot(normalize(vDir), uSunDir), 0.0);
          c += uSun * (pow(s, 600.0) * 30.0 + pow(s, 12.0) * 0.6);
          gl_FragColor = vec4(c, 1.0); }`,
    }));
  scene.add(dome);
  if (panels) {
    const panel = (w, h, pos, intensity) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(intensity), side: THREE.DoubleSide }));
      m.position.set(...pos); m.lookAt(0, 0, 0); scene.add(m);
    };
    panel(14, 6, [0, 22, 0], 2.2);
    panel(10, 5, [-24, 9, 8], 1.2);
    panel(8, 5, [22, 7, -12], 0.8);
  }
  return scene;
}

export function applyLook(THREE, renderer, scene, opts = {}) {
  const budget = opts.budget ?? tierBudget(opts.tier ?? 'laptop');
  const rev = revisionOf(THREE);

  // Color: sRGB output, filmic tone mapping (AgX where present, ACES otherwise or on request).
  if ('outputColorSpace' in renderer && THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
  const tm = opts.toneMapping ?? 'agx';
  renderer.toneMapping = tm === 'agx' && THREE.AgXToneMapping !== undefined ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = opts.exposure ?? 1.0;
  if (typeof window !== 'undefined' && renderer.setPixelRatio) renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, budget.pixelRatioCap));

  // Environment light: a PMREM-filtered environment for reflections and ambient.
  let envMap = null, envTarget = null;
  if (opts.environment !== false) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    if (opts.environment && opts.environment.isTexture) {
      envTarget = pmrem.fromEquirectangular(opts.environment); envMap = envTarget.texture;
    } else {
      const envScene = makeEnvironmentScene(THREE, opts.sky ?? {});
      envTarget = pmrem.fromScene(envScene, 0.04); envMap = envTarget.texture;
      envScene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    }
    pmrem.dispose();
    scene.environment = envMap;
    // scene.environmentIntensity exists from r163; older builds ignore envIntensity.
    if ('environmentIntensity' in scene) scene.environmentIntensity = opts.envIntensity ?? 1.0;
    if (opts.background === 'environment') scene.background = envMap;
  }

  // One shadowed key light with a shadow camera fitted to the play area.
  let keyLight = null;
  if (opts.keyLight !== false) {
    const k = opts.keyLight ?? {};
    keyLight = new THREE.DirectionalLight(k.color ?? 0xfff2df, k.intensity ?? 2.2);
    const dir = new THREE.Vector3(...(k.direction ?? [0.5, 0.8, 0.3])).normalize();
    const b = opts.bounds ?? { center: [0, 0, 0], radius: 8 };
    const c = new THREE.Vector3(...b.center);
    keyLight.position.copy(c).addScaledVector(dir, b.radius * 2.5);
    keyLight.target.position.copy(c);
    scene.add(keyLight, keyLight.target);
    if (budget.shadows && opts.shadows !== false) {
      renderer.shadowMap.enabled = true;
      // r180+ deprecates PCFSoftShadowMap (softness comes from shadow.radius on PCFShadowMap).
      renderer.shadowMap.type = rev >= 180 ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
      keyLight.castShadow = true;
      const s = keyLight.shadow;
      s.mapSize.set(budget.shadowMapSize, budget.shadowMapSize);
      const r = b.radius;
      Object.assign(s.camera, { left: -r, right: r, top: r, bottom: -r, near: 0.1, far: r * 6 });
      s.camera.updateProjectionMatrix();
      s.bias = k.bias ?? -0.0004;
      s.normalBias = k.normalBias ?? 0.02;
      s.radius = k.softness ?? 3;
    }
  }

  // Fill from the sky so shadowed sides are never black.
  const fill = new THREE.HemisphereLight(opts.skyColor ?? 0xbfd4ee, opts.groundColor ?? 0x5a4d40, opts.fillIntensity ?? 0.35);
  scene.add(fill);

  if (opts.fog) scene.fog = new THREE.FogExp2(opts.fog.color ?? 0xc9d3dc, opts.fog.density ?? 0.02);

  return {
    budget, envMap, keyLight, fill,
    dispose() {
      if (scene.environment === envMap) scene.environment = null;
      if (scene.background === envMap) scene.background = null;
      envTarget?.dispose();
      if (keyLight) { keyLight.shadow?.dispose?.(); scene.remove(keyLight, keyLight.target); keyLight.dispose?.(); }
      scene.remove(fill); fill.dispose?.();
      if (scene.fog && opts.fog) scene.fog = null;
    },
  };
}

// Make every mesh cast and receive shadows (call after loading a model or building a scene).
export function groundShadows(root, { cast = true, receive = true } = {}) {
  root.traverse((o) => { if (o.isMesh) { o.castShadow = cast; o.receiveShadow = receive; } });
}
