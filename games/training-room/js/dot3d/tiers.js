// dot3d quality tiers: Quest 2/3, Galaxy Tab S4, laptop (i5-1135G7 Iris Xe). Auto-detected, overridable with ?tier=.
// Claude (Command), Oct 25 2026. Budgets come from the remaster bar (scratch/remaster-3d/REMASTER-BAR.md).
export const BUDGETS = {
  quest:  { fpsFloor: 72, pixelRatioCap: 1,   shadowMapSize: 1024, shadows: true, post: false, pointLights: 4, maxParticles: 600,  maxDecals: 48,  textureSize: 256, drawCalls: 150, triangles: 300000 },
  tablet: { fpsFloor: 30, pixelRatioCap: 1.5, shadowMapSize: 1024, shadows: true, post: false, pointLights: 8, maxParticles: 900,  maxDecals: 64,  textureSize: 256, drawCalls: 250, triangles: 500000 },
  laptop: { fpsFloor: 60, pixelRatioCap: 2,   shadowMapSize: 2048, shadows: true, post: true,  pointLights: 16, maxParticles: 2500, maxDecals: 128, textureSize: 512, drawCalls: 600, triangles: 1500000 },
};

export function detectTier(env = {}) {
  const nav = env.navigator ?? (typeof navigator !== 'undefined' ? navigator : {});
  const search = env.search ?? (typeof location !== 'undefined' ? location.search : '');
  const forced = new URLSearchParams(search).get('tier') ?? env.override;
  if (forced && BUDGETS[forced]) return forced;
  const ua = String(env.userAgent ?? nav.userAgent ?? '');
  if (/OculusBrowser|Quest|Pico/i.test(ua)) return 'quest';
  if (/Android|iPad|Tablet|SM-T/i.test(ua)) return 'tablet';
  return 'laptop';
}

export function tierBudget(tier) {
  return { tier, ...(BUDGETS[tier] ?? BUDGETS.laptop) };
}
