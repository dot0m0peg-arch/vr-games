# Training Room remaster: LOOK BIBLE

Art direction for the in-place remaster of Training Room (pipeline project `training-room-remaster`). Rules, catalog, saves, controls, physics, hands, hits and sticking stay exactly as they are; this document decides only how the game looks and what effects it gets. Serves the finish line in projects.json and the bar in `scratch/remaster-3d/REMASTER-BAR.md`. Candidate copy: this folder. Before shots: `scratch/vr-physics-build-20261025/captures/before/` (taken Oct 26 2026 06:34 UTC, laptop, 60 fps, 28 records, 26 parts).

## 1. What it should feel like

A real training yard worn into a real meadow: packed dirt where feet go, grass leaning in the wind everywhere else.
Oak, straw, iron and canvas, every one of them sun-faded and handled, nothing glossy, nothing cartoon-bright.
In the Quest 2 the dummy is a thing you could lean on; the sword in your hand has a brushed edge you can see the sky in.
Things you summon rise out of a glowing seam in the air with a drift of motes, then stand on the ground with a shadow under them.
When you hit something, the world answers: a gash in the wood, a scuff on the stone, sparks off the iron, straw in the air.

## 2. References

1. A Kentucky horse-farm paddock at 10 AM in June: hazy blue-white horizon, green grass with dry tips, worn dirt by the fence. Take the sky and the grass colors.
2. Fort Ticonderoga parade ground: grey limestone wall with pale mortar, packed tan dirt, black iron cannon on oak carriages. Take the wall, the dirt and the iron.
3. Warwick Castle trebuchet field: straw targets, hay bales and sawn timber on grass, all weathered to grey-gold. Take the straw, the hay bale and the weathered plank.
4. Kingdom Come: Deliverance (game): straw dummies, dark oak, undyed linen tunics, no saturated primaries anywhere. Take the material restraint and the Kingdom tunic palette.
5. Ghost of Tsushima (game): wind in the grass, height fog on the hills, the sun low and gold. Take the sunset and the way the horizon reads.
6. Half-Life: Alyx (game): held objects at arm's length with visible wear, fingerprints and edge highlights. Take the close-up material standard for everything holdable.
7. Skyrim's Whiterun market (game): a trodden dirt square, canvas awnings, timber stalls, chimney smoke. Take the Kingdom plaza.
8. A Coleman camp lantern and a real campfire at dusk: warm pools of light with a soft falloff, cool blue everywhere else. Take the night lighting.

## 3. Palette

Base hues are the existing `PRESETS` in `js/world/field.js` lines 20-45 and stay as the sky base; what changes is listed per preset.

| Time | Sky zenith / horizon (kept) | Sun (kept) | Change |
|---|---|---|---|
| day | `#3f86d8` / `#c9e2ee` | `#fff2dc` at 2.9 | ground `below` `#9dbb8a` becomes dirt-and-grass `#7f8f5a`; hemiGround `#6f8a3c` becomes `#5f6e38`; exposure 1.0 |
| sunset | `#3c5d9c` / `#f2b07a` | `#ffb36b` at 2.2 | sun elevation stays 5 deg; exposure 0.92; fog color warms to `#e9a470`; shadows lengthen (same light, fitted box widens to 20 m) |
| night | `#050b1e` / `#1b2a4b` | moon `#a9c1ff` at 0.9 | moon intensity drops to 0.5; lamp post and campfire become the key lights (section 6); exposure 1.15 |
| dawn | `#4b4f93` / `#f0a6b9` | `#ffc6c0` at 1.9 | exposure 0.95; fog color `#d9a8b4`; ground mist band 0-1.5 m, density 0.03 |

Named material colors (albedo, sRGB; the texture carries the variation):

| Name | Hex | Used by |
|---|---|---|
| grass root / tip / dry | `#1d3a10` / `#7fb63f` / `#b8bf5c` (kept from field.js) | grass blades |
| meadow ground | `#5e6b3a` with dirt patches `#7a6447` | ground texture under the grass |
| plaza dirt | `#8a6a45` base (kept), worn ring `#9c7d57`, damp edge `#6e5436` | Kingdom plaza |
| oak (new) | `#8b6a42` | handles, dummy post, rack, table, chair, bench |
| weathered plank | `#a08a66` | crates, barrel staves, fence, stall, shed |
| bark | `#5a4a3c` | trees, log, stump |
| straw | `#c9a55a` (kept from kingdom thatch) with dark seams `#8c6f36` | dummy body, hay bale, thatch, straw hats |
| iron | `#3a3d40`, rust `#6b4a35` in crevices | axe head, mace, cannon, kettlebell, hoops, lamp post, hinges |
| steel | `#b9bec2`, edge highlight `#e6e9ea` | sword, katana, dagger, spear head, halberd, armor |
| stone | `#8f8a80`, mortar `#c4bcac` | physics wall, wall, castle, chapel, well, fountain, pillar |
| mortar / plaster | `#d8d0c0` | villa, house render |
| linen cloth | `#d8cfb8` | tent, awning stripes, villager tunics base |
| Kingdom tunics | `#8a6b3f #6d7f4a #7b5b8a #a4573c #4f6f86 #9a8a5a` (kept from kingdom.js) | advisors, villagers |
| leather | `#5c3e2a` | grips, shield straps, armor straps, belts |
| ceramic | `#e8e2d6` glaze, `#b8a690` foot | coffee mug |
| felt | `#2f5a3c` | card table top, chess board rim |
| paper | `#efe9db` | deck of cards, sticky notes, notebook |
| fire | core `#fff1c8`, body `#ff9a3c`, ember `#ff5a1a`, smoke `#6c6762` | campfire, grill, coals |

Not allowed in a final scene:
- saturated flat primaries (`#ff0000`-style red, `#00ff00` green, `#0000ff` blue); the current `#f26a1b` cone orange survives only as the cone's own paint with scuffed wear;
- pure black `#000000` (darkest allowed albedo `#15161a`) and pure white `#ffffff` (brightest allowed albedo `#ebe8e2`);
- any untextured MeshStandardMaterial on a part, including the current `kit.js` flat `matte` and `plastic` kinds;
- hard cartoon outlines, toon ramps, or emissive used as a stand-in for a texture;
- green spheres for tree canopies (section 5 gives trees leaf cards and bark).

### 3a. Connor's verdict, Oct 26 2026: the de-cartoon grade (build order step 13a)

Owner's words, Oct 26 7:44 AM (Claude Duet transmitter): "Connor said that he wishes we could make good games instead of cartoony games, and I think you should tell command that the graphics have not impressed the nine year old". Checked against the step-12 captures, what read as cartoony was not the materials (every part already carries a textured family) but the grade and the light:

1. **Front light.** The day sun sat at az 140, behind the player, so every shadow fell behind its object and out of view; the shadow probe darkened under 1% of the field-overview frame. A front-lit scene is the flattest light there is. The day sun now stands at **az 60, el 40** (three-quarter front, right): every part has a lit side, a shaded side and a shadow on the grass. Sunset, dawn and night keep their directions.
2. **Fill that drowned the key.** Hemisphere 1.1 plus environment 1.0 against a 2.9 sun left shadows a few percent darker than lit ground. Day fill is now **hemisphere 0.55, environment 0.55, sun 3.3, exposure 0.95**; sunset 0.5 / 0.5 / 2.5; dawn 0.5 / 0.45 / 2.2; night hemisphere 0.45, environment 0.3.
3. **Crayon hues.** The "kept" sky and grass hues were the cartoon: sky zenith `#3f86d8`, horizon `#c9e2ee`, grass tip `#7fb63f`, ground `#4a7330` with blotches to `#6a8d3e`. Now: day zenith `#4d7fb8`, horizon and fog `#cfd8dd` (grey haze), below `#6e7a50`, hemisphere `#c4d3e2` / `#4c5730`; grass root `#25391b`, tip `#789643`, dry `#a9a263`; ground base `#55653a`, blotches `#4b5f31`-`#75844a`, strokes `#3a4d27`-`#a3a862`. Sunset and dawn horizons desaturated by about 15% (`#e6b48a`, `#e6afbc`). The section 3 tables above record the pre-verdict values; where they differ, this subsection wins.

Rule from the verdict, for every later step and every other remaster: **no front light at the fixed spots** (the key light comes from the side or three-quarter front, 30-45 degrees up), **fill at most 0.6 of the key**, and **no albedo or sky hue above 0.6 HSV saturation except fire, flags and painted props**. Measured by the capture: in the six fixed spots, the share of vivid pixels (saturation over 0.55 at value over 0.35) in the day spots is at most 0.65 of the step-12 captures, and the shadow probe's mean darkening at the dummy and the crates at least 1.4x and 2.5x step 12. What still reads toy-like after this grade is shape, not light: the box crates, cone pines and sphere canopies of the family sculpts, which step 8 replaces with real models as they arrive (section 5).

## 4. Materials

Source key: `proc` = `dot3d createMaterials(THREE).get(name)` in `js/dot3d/materials.js` (existing recipes: wood, carpet, rock, dirt, concrete, plaster, grass, paint, metal; flats: chrome, rubber, glass, emissive). `proc-new` = a recipe added to that file under a new name (additive; no existing name changes). `PH` = Poly Haven CC0 texture set, 1K on Quest and Tab, 2K on laptop (set names must be verified on polyhaven.com at build time; if a name is gone, pick the nearest set in the same category and record it in the manifest). `own` = the GLB's own PBR textures (owner Meshy or free model). Tiling is metres per repeat. Physics material (`material.userData.physMaterial`, what contacts.js and particles rules read) in the last column. Rule: no flat-color primitives in a final scene.

| Family | Roughness | Metalness | Source | Tiling (m) | Catalog parts | Phys |
|---|---|---|---|---|---|---|
| wood (oak, handles) | 0.55-0.72 | 0 | proc `wood` tinted oak; PH `wood_table_001` on laptop | 1.0 | sword/axe/staff/bat grips, dummy post, rack, bench, chair, card table, desk, picnic table, lectern | wood |
| wood (plank, weathered) | 0.7-0.85 | 0 | proc-new `plank` (grey-gold, knots); PH `wood_planks_grey` | 1.2 | crate, barrel, fence, shed, stall, cabin, tower, footbridge, stairs, ramp, obstacle wall, barricade, catapult, weapon rack back | wood |
| straw | 0.9-1.0 | 0 | proc-new `straw` (parallel stalks, dark seams, 25% alpha-cut fringe on edges) | 0.5 | training dummy body, hay bale, farm field, straw hats, thatch (tavern, stall roof) | soft (sticks: straw) |
| iron | 0.6-0.8 | 0.9-1.0 | proc-new `iron` (dark, pitted, rust in low fbm) ; PH `rusty_metal_02` | 0.6 | axe head, battle axe, mace, war hammer head, kettlebell, dumbbell, cannonball, cannon, hoops, lamp post, hinges, anvil, gong stand | metal |
| steel | 0.22-0.38 | 1.0 | proc `metal` (brushed) with edge-wear mask; `own` on models | 0.4 | sword, katana, dagger, spear head, halberd, arrow head, crossbow prod, shield rim, suit of armor | metal |
| stone | 0.8-0.95 | 0 | proc `rock` tinted `#8f8a80` + mortar lines (proc-new `blocks`); PH `castle_brick_02b` / `cobblestone_floor_08` | 1.5 blocks, 1.0 cobbles | physics wall, wall, castle, chapel, well, fountain, arch, pillar, boulder, rock, statue base, blacksmith | stone |
| plaster | 0.85-0.95 | 0 | proc `plaster` tinted | 2.0 | villa, house, tavern render, windmill, lighthouse | stone |
| cloth (linen, canvas) | 0.85-1.0 | 0 | proc-new `cloth` (weave, 2-tone stripe option) ; PH `fabric_pattern_07` | 0.35 | tent, awning, flag, banner, sandbags, tunics, hammock, punching bag cover, boxing ring canvas | soft |
| leather | 0.5-0.65 | 0 | proc-new `leather` (grain, worn edges) ; PH `leather_red_02` tinted | 0.3 | grips, shield straps, armor straps, saddle-style seats, football, basketball | soft |
| glass | 0.03-0.08 | 0 | proc flat `glass` (opacity 0.35, ior 1.5) | n/a | windows (villa, house, tavern, lamp post), monitor, laptop screen off-state, crystal | stone |
| ceramic | 0.15-0.3 glaze, 0.8 foot | 0 | proc-new `ceramic` (glaze speckle, unglazed foot ring) | 0.2 | coffee mug, snack bowl, fountain basin inner, potted plant pot | stone |
| felt | 0.95-1.0 | 0 | proc `carpet` tinted `#2f5a3c`, normal strength 0.5 | 0.5 | card table top, chess board rim, rug, poker chips tray, dartboard surround | soft |
| paper | 0.6-0.75 | 0 | proc-new `paper` (fiber grain, slight yellowing); card faces are canvas-drawn as today | 0.1 | deck of cards, playing card, sticky note, notebook, whiteboard (satin 0.3), clipboard | soft |
| foliage | 0.75-0.9 | 0 | proc-new `leaf` alpha-cut card texture (3 leaf cluster variants), DoubleSide, translucency 0.4 in the field shader | 0.6 | tree, pine tree, palm tree, birch tree, bush, potted plant, flowers, farm field crops | soft |
| bark | 0.85-0.95 | 0 | proc-new `bark` (vertical furrows) ; PH `bark_willow_02` | 0.8 vertical | tree trunks, log, stump, dead tree, stick | wood |
| dirt | 0.9-1.0 | 0 | proc `dirt` (kept recipe, tint `#8a6a45`), worn ring mask | 1.5 | Kingdom plaza, trodden path discs under dummy/rack/stall, farm field furrows, pond bank | soft |
| fire | n/a (additive) | 0 | proc-new flame sprite sheet 4x4 in `js/dot3d/vfx-textures.js` style; emissive coals `proc` `emissive` tinted `#ff5a1a` | n/a | campfire, grill coals, blacksmith forge, lamp post flame, lighthouse beacon | n/a |

`js/parts/build/kit.js` `mat(color, kind)` keeps its signature and cache; its KINDS (matte, plastic, wood, stone, fabric, metal, gold, glass, glow, leaf) map onto these families (matte -> plaster or paint by part, plastic -> paint, wood -> oak or plank by part, stone -> stone, fabric -> cloth, metal -> steel or iron by hex luminance below 0.35 -> iron, gold -> proc metal tinted `#d9b45b`, glass -> glass, glow -> emissive, leaf -> foliage). `userData.kind` is preserved so `js/physics/colliders.js` line 20 keeps reading it.

## 5. Models

139 built-in parts (combat 36, structures 24, office 24, nature 19, leisure 16, props 13, kingdom 7). Every catalog name and alias in `js/parts/meta/*.js` keeps working: a model is attached by catalog `name`; the builder in `js/parts/build/*.js` stays as the fallback and as the collider source. A GLB that fails to load falls back to the family sculpt silently (one console warning, never an error).

Priority 30, in build order (what the player holds and hits most, then what the six spots show):

1-8 held and hit (spot 2, 3): sword, axe, shield, training dummy, wooden sword, dagger, katana, spear.
9-16 yard (spot 1, 3): crate, barrel, hay bale, weapon rack, archery target, bench, lamp post, campfire.
17-22 table (spot 4): card table, chair, coffee mug, chess board, deck of cards, whiteboard.
23-26 Kingdom (spot 5): market stall, peasant (villager body), castle, house.
27-30 horizon (spot 1, 6): villa, tree, pine tree, farm field.

Sources, in this order:
1. Owner Meshy exports (section 12), byte-for-byte with provenance in the manifest.
2. Meshy community pulls that another seat will place in `C:\Users\dot0m\Documents\TrainingRoom-FreeModels\meshy\` (same `<item>.glb` + `<item>.part.json` layout as the other folders).
3. `TrainingRoom-FreeModels\polyhaven\` (73 GLBs, CC0, 154 MB). Direct catalog matches today: katana, dagger, mace, hatchet (= axe alias), sledgehammer (= war hammer alias), machete, saber, chess-set, dining-chair, dining-table, sofa (= couch), television, chalkboard, stapler, notebook, clipboard, flashlight, oil-lamp, wall-sconce, bucket, watering-can, fire-pit, wicker-basket, baseball, football, ukulele.
4. `TrainingRoom-FreeModels\objaverse\` (17 GLBs, 8 MB, CC BY 4.0 per `CREDITS.csv`; attribution goes on the Menu's credits panel): cat, fox, frog, rabbit, dragon, seagull, starfish, calculator, cucumber, donut, whisk, door knocker, bluetooth speaker, bubble tea, pomelo, sniper rifle, double barrel shotgun.
5. The 38 MB `job\state\index.json` is the item index for the parts-bin families, not a model list; it is not a source.

Every asset used is recorded in `assets/models/MANIFEST.json` (name, file, source URL, license, author, sha256, triangles, rejected reason if any).

Scale and pivot rules:
- 1 unit = 1 m. On load the model's bounding box is measured and uniformly scaled so its largest axis equals the catalog `size` largest axis.
- If the other two axes then miss the catalog size by more than 15%, the model is rejected for that part (manifest `rejected: reason`) and the sculpt stays. Step 8 refinement (Command, Oct 26): an entry may widen one minor axis by at most 120 mm with a `tolerance` and a `fitNote`, for a real crossguard or spear head that stands out of the sculpt's slab; a body that is twice its collider is still rejected, because the colliders stay the sculpt's.
- Pivot: base center at y = 0 on the ground, front toward +Z (the `kit.js` convention).
- Holdable parts keep the catalog `grip.p`/`grip.r`; the model is translated so its handle lands on the catalog grip point (sword grip at [0, 0.14, 0], axe at [0, 0.18, 0], spear at [0, 0.75, 0]).
- `tip` and `js/physics/edges.js` EDGES stay catalog-space and are not touched; colliders keep coming from the sculpt's boxes, so physics is unchanged by a model swap.
- Triangle caps per model: held 6,000, yard prop 12,000, building 40,000 (castle 60,000), tree 4,000 plus leaf cards.
- Textures 1024 px max on Quest (2048 on laptop), one material per model where possible.
- Repeated parts (crates, villagers, trees, fence sections) use InstancedMesh.

Long tail (the other 109 parts):
- The family sculpts stay, but every box gets a 6-12 mm bevel (`kit.js` `box` gains an optional `bevel` like `extrude` already has).
- Every cylinder gets 24 segments at radius > 0.1 m; normals are recomputed smooth within 35 degrees.
- Every material comes from section 4; no sculpt keeps a flat color.
- Astra's named flaws from `scratch/training-room-3d-audit-20261024` are fixed in the same pass where a sculpt is touched.
- The ~290k parts-bin family records route to the same 225 family templates and inherit the family materials automatically.

## 6. Lighting rig

One rig, four presets, all driven from `field.setTime` so the existing 3 s crossfade keeps working.
- Key light: the field's own `sun` (DirectionalLight, `js/world/field.js` line 936, today `castShadow = false`) becomes the shadowed key: `castShadow = true`, shadow camera an orthographic box fitted to the play area, following the player's head on the ground plane, snapped to shadow-texel steps so edges do not swim.
- dot3d plug-in: `js/main.js` calls `applyLook(THREE, renderer, scene, { tier, toneMapping: 'agx', exposure, keyLight: false, environment: <PMREM per preset>, sky: { sky: zenith, horizon, ground: below, sun: sunColor, sunDir }, fillIntensity: 0 })` at startup, replacing lines 54-55's ACES/exposure 1 setup.
- `keyLight: false` because the field owns the sun; `fog` omitted because the field owns its linear `THREE.Fog` (line 915) whose color is the horizon; `fillIntensity: 0` because the field's HemisphereLight (line 934) is the fill.
- Environment: four maps baked once at startup with `makeEnvironmentScene` from each preset's colors (4 x 256 px PMREM, about 2 MB total); `scene.environment` swaps at the crossfade midpoint and `scene.environmentIntensity` follows the preset.
- Tone mapping is AgX on every tier (ACES only if the vendored three lacks AgX; r185 has it). Output is sRGB.

| Preset | Sun dir (az/el, kept) | Sun | Hemisphere | Env intensity | Shadow box | Fog (linear, kept keys) | Exposure | Tone |
|---|---|---|---|---|---|---|---|---|
| day | 140 / 52 | `#fff2dc` 2.9 | sky `#cfe4ff` ground `#5f6e38` 1.1 | 1.0 | quest 14 m radius 1024, tablet 14 m 1024, laptop 22 m 2048 | 60 / 1900 color `#c9e2ee` | 1.0 | AgX |
| sunset | 28 / 5 | `#ffb36b` 2.2 | `#a7b0dc` / `#6b5a2c` 0.9 | 0.8 | same sizes, box widened x1.4 in the sun's ground direction | 50 / 1700 `#e9a470` | 0.92 | AgX |
| night | moon -24 / 32 | `#a9c1ff` 0.5 (sunVis 0) | `#4a68a8` / `#22342b` 0.6 | 0.35 | same; moon casts the shadow at 1024 | 30 / 1300 `#1b2a4b` | 1.15 | AgX |
| dawn | -38 / 7 | `#ffc6c0` 1.9 | `#b6a8e0` / `#5d5a3a` 0.9 | 0.75 | same as sunset | 50 / 1700 `#d9a8b4` | 0.95 | AgX |

Step 13a (section 3a, Oct 26) changed this table's day row to sun az 60 / el 40 at 3.3, hemisphere 0.55, environment 0.55, exposure 0.95, and halved the other presets' fill; the directions and sizes of the shadow box are unchanged.

Shadow params from `applyLook`'s defaults: bias -0.0004, normalBias 0.02, PCF radius 3 (r185 uses PCFShadowMap). Every part mesh casts and receives (`groundShadows`), grass receives via its own shader sampling the shadow map (one extra texture read; cut on Quest if step 13 needs it, keeping the ground receive).

Night emitters:
- Lamp post: `PointLight` `#ffcf8a` 18 cd, distance 14 m, decay 2, at the lantern (y 3.4 m); emissive lantern glass at 6; a 2.2 m soft halo sprite in the field.
- Campfire: `PointLight` `#ff9a3c` 10 cd, distance 9 m, decay 2, at y 0.35 m, flicker 0.75-1.25 at 7 Hz with a 2.3 Hz drift; emissive coals as today (`js/parts/build/leisure.js` line 571 pattern).
- Floor lamp, desk lamp, oil lamp parts: `#ffe0b0` 6 cd, distance 5 m; lighthouse beacon: a rotating 40 cd spot, 6 s per turn, only on laptop.
- Point lights are capped at the 4 nearest to the player on Quest, 8 on tablet, 16 on laptop; the rest keep only their emissive.
- No point light casts a shadow (cost); the lamp's halo and the fire's ground glow are decals (a warm `glow` kind added beside `scorch`, 3 m and 2 m).

## 7. Effects with causes

All contact effects come from the existing chain, nothing is canned:
- Rapier contact -> `createContactBridge` (`js/dot3d/contacts.js`) -> bus `contact` {point, normal, impulse N*s, relVelocity, materials} -> `createParticles` rules and `createDecals` rules. Haptics and sound are already in `js/physics/hits.js` and stay.
- New materials in the bridge: `straw` (dummy body, hay bale, thatch, farm field) and `grass` (the ground collider), registered where colliders are made from the part's family; `defaultRules` in `js/dot3d/particles.js` gains rows for both.
- Pool sizes come from `tierBudget`. Today `js/main.js` line 853 hard-codes 256 particles and 64 decals on every tier; that is one concrete reason "the particles aren't particulating": one swing's 60 sparks plus 30 chips plus 24 dust exhausts a 256 pool in three hits, and the oldest are recycled mid-flight.
- Second reason: everything today is `metal`/`wood`/`stone`/`soft`, so the dummy and the hay bale puff grey dust instead of throwing straw. Third: no decal kind reads the blade's edge direction, so a sword leaves the same round scuff as a dropped ball.
- Every burst is seeded per hit (existing PRNG), so no two hits look the same; particles spawn only at a real contact point, inherit the striker's velocity, fall, bounce and settle (existing behavior kept).

| Cause | Effect | Module |
|---|---|---|
| steel or iron on stone, impulse >= 0.8 N*s (a tap is ~3, a swing 15-25) | sparks: count 6 + 10 x impulse^0.7 up to 60, size 12-30 mm, life 0.4-1.0 s, gravity -9.8, bounce 0.45, color ramp white-gold to orange to dark (existing `sparks`); grey stone chips 3-30; dust puff 3-24; decal `scuff` 50-300 mm sized by sqrt(impulse) | particles.js, decals.js (existing) |
| steel on wood, impulse >= 0.8 | wood chips 3-30 (`#8c6133`), tan dust; decal new kind `gash`: a dark 2-pixel-wide slit texture 60-220 mm long oriented along the blade's edge direction (from `edges.js` `dir` projected on the surface), opacity 0.9, fades after 30 s like the others | decals.js (new kind `gash`, texture in vfx-textures.js), particles.js |
| axe or sword sticks (bus `stick`) in wood or straw | at the stick point: a `gash` decal 120 mm plus 8-14 chips or straw wisps; haptic thunk already in hits.js | decals.js, particles.js |
| anything on straw (dummy, hay bale), impulse >= 0.5 | straw wisps: new kind `wisps` = chips layer, count 4 + 6 x impulse^0.7 up to 24, flat 20-60 mm cards colored `#c9a55a`-`#8c6f36`, gravity -2.0, drag 1.5, spin 8, life 1.5-3.0 s, rest and linger 6 s on the ground; dust x0.4 tinted `#d9c48a`; no decal (straw does not mark) | particles.js (new kind + rule) |
| blunt on anything (bat, staff, hammer, mace) | same by struck material at x0.7 scale; a `scuff` decal only above 4 N*s | particles.js rules (scale by striker edge-less) |
| throw landing on grass (any body on `grass`, impulse >= 0.5) | dust puff tinted green-tan `#9fa868` count 3-16, size 50-110 mm growing x1.6; 2-8 green `grass` flecks (chips kind, `#6f9a3a`, 15-30 mm) ; grass clearing pulse: setClearing radius +0.2 m for 0.4 s then back | particles.js, field.js clearing |
| throw landing on stone/wood/metal | existing material rules at the landing point; `scuff` decal | existing |
| crate or barrel hit above 12 N*s | plank chips x1.5 and a short 2 cm shake of the mesh (0.25 s, damped sine); no breakage (not in scope) | particles.js, behaviors |
| tear-off (dummy arm or hay bale burst by the rig) | 24-40 wisps in a 0.3 m sphere, dust 12, one `thud` sound already present | particles.js `burst('wisps', {radius: 0.3})` |
| gong hit, metal >= 2 N*s | sparks x0.5 plus a 0.5 s golden ring flash (emissive pulse to 4) ; sound exists | particles.js + part behavior |
| arrow or crossbow bolt sticks in the archery target or a hay bale (bus `stick`, straw) | 6-10 wisps at the entry point, a 15 mm dark `gash` dot, the target's rings shake 1 cm for 0.3 s | decals.js, particles.js |
| training dummy struck above 6 N*s (the existing rig swings it) | wisps by impulse as the straw row, plus 4-10 dust on the post base when it springs back past vertical | particles.js (rig already emits the contact) |
| iron dropped on stone or wood (kettlebell, cannonball, dumbbell), >= 4 N*s | stone or wood chips x1.2, a `chip` decal 60-120 mm (existing kind), no sparks unless metal on metal | existing rules |
| "make it real" on a magic-marker drawing | the materialize seam starts at the drawing's frame origin and motes spawn along the stroke points (`data.strokes`, up to 120 points sampled) for the first 0.4 s, then the normal reveal runs | world/phase.js + core/sketch.js bounds |
| campfire / grill / forge (continuous while visible within 30 m) | embers: new kind `ember` (glow layer), 5/s, size 8-20 mm, life 1.2-2.4 s, gravity +0.8 (buoyant), drag 1.2, sideways wind from the field's uWindDir x0.3, color ramp `#fff1c8` -> `#ff5a1a` -> dark; smoke: dust layer tinted `#6c6762`, 2/s, size 150 mm growing x3 to 600 mm, life 2.5-4 s, rise 0.6 m/s, alpha peak 0.35; flame: 3 cross-planes with the 4x4 sprite sheet at 12 fps, additive, 0.5 m tall, flicker scale 0.85-1.15 at 7 Hz; point light per section 6 | particles.js (new kinds), build/nature.js campfire |
| phase-in / materialize (summon, "make it real", load of a saved room is instant: no effect) | see below | world/phase.js + particles.js |
| phase-out (erase, undo) | the same seam runs top to bottom in 0.7 s (kept), motes fall instead of rise, no ring | world/phase.js |

Materialize, in full. The existing effect in `js/world/phase.js` (reveal by object-local height, band 0.08 m, scanlines 0.016 m, 1.4 s in, ground ring and rising sparkles, shader patch via onBeforeCompile) is the right design and keeps its mechanism; what changes is its sizing, its particles and its timing to the summon.
- Timing: the effect starts on the summon ack (the same frame the record is added), not after the model loads; if a GLB is still loading, the sculpt proxy is revealed and the model swaps in under the reveal band once it arrives (the band hides the swap). Duration `clamp(1.0 + 0.12 x height, 1.2, 2.6)` s: coffee mug (0.1 m) 1.2 s, sword 1.2 s, training dummy (1.82 m) 1.22 s, house (6.92 m) 1.83 s, villa (9.04 m) 2.08 s, castle (15.3 m) 2.6 s. The reveal eases out (kept `easeOut`).
- Seam: band height `clamp(0.04 + 0.03 x height, 0.05, 0.25)` m (mug 50 mm, dummy 95 mm, villa 250 mm). Band color warm white-gold `#ffd9a0` at emissive 1.25 (kept formula), scanlines kept; below the seam the surface is fully lit PBR, above it is clipped. Band light: one `PointLight` `#ffd9a0` rides the seam center at intensity `clamp(1.5 x height, 2, 10)` cd, distance 2 x height, off on Quest when the active point-light cap is reached.
- Motes: the sparkle Points in phase.js are replaced by dot3d `shimmer` bursts (existing kind: speed 0.15-0.5 m/s, buoyant gravity +0.35, life 0.8-1.6 s, size 15-40 mm, cyan-white ramp retinted to `#ffe6b8`): every 50 ms a `burst('shimmer', { point: seam center, radius: half the footprint diagonal, scale })` with scale so the total over the effect is `clamp(12 + 40 x footprint m^2, 12, 400)` motes (mug 12, dummy 26, crate 44, villa 400 on laptop; the Quest cap halves anything above 100). Motes spawn on the seam, not inside the volume, so a villa shows a rising rectangle of light, a mug a pinch of sparks.
- Ground: the existing ring at the footprint plus 0.2 m, 0.35 s pulse, opacity 0.6, only for parts with footprint >= 0.1 m^2 (a mug gets no ring). Parts with height >= 3 m add a dust puff (12-24, tinted by the ground material) at the base 0.3 s after the seam clears the top, as if it settled.
- In hand: a part summoned "in my hand" reveals from grip to tip in 0.9 s with motes along the seam only (no ring, no dust); the existing local-height logic already gives handle-butt-to-head.
- Sound: the existing summon sound stays and starts with the seam.
- Big vs small summary: villa = 2.08 s, 250 mm seam, 400 motes, ring, dust settle, light flash capped on Quest; mug = 1.2 s, 50 mm seam, 12 motes, no ring, 2 cd flash.

Particle pool per tier: `tierBudget().maxParticles` (600 / 900 / 2500) and `maxDecals` (48 / 64 / 128), replacing the hard-coded 256 / 64. Every burst is seeded per hit (existing PRNG), so no two hits look the same; nothing spawns away from a real contact point.

## 8. Scale and grounding

- 1 unit = 1 m everywhere; catalog `size` is the truth for every part, model or sculpt.
- Standing eye height 1.6 m on desktop (camera at 1.6; capture spot 1 uses 1.7 deliberately for the overview and stays); in VR the headset's real height is used as today.
- Everything casts and receives the key-light shadow inside the shadow box; outside it (beyond 14 m on Quest) every dynamic part keeps a contact blob: a `decals.js` new kind `blob` (soft dark ellipse, 0.9 x footprint, opacity 0.35) that follows the body each frame while it is held, thrown or settling, then is released. Held parts always have the blob under them so a sword swung in the air shows on the ground.
- Nothing floats: every record's visual root is at `p` with base at y = 0 (kit.js convention), and GLBs are re-based on load (section 5). Records with `onto` keep the `surface` height from the catalog. A loaded model whose base is more than 10 mm off the ground after re-basing fails the manifest check.
- Nothing clips: the grass clearing system in `field.js` (`setClearing(scene, key, x, z, radius, strength)`, 12 nearest sent to the GPU) is applied to every record with a footprint >= 0.04 m^2 at radius `max(size.x, size.z) / 2 + 0.15` m, strength 1, and to the Kingdom plaza at 9 m as today. Under heavy yard parts (dummy, rack, crate stack, stall, campfire) a trodden-dirt decal disc (`dirt` family, radius = clearing radius) sits at y = 0.005 so the grass does not look shaved around a thing standing on green felt. The grass receives shadows so parts sit in it, not on it.
- Walls are solid (already built, Rapier colliders); the physics wall in the capture scene renders as blocks and mortar, not a grey slab.

## 9. Camera and capture rules

Spots are `SPOTS` in `js/capture.js`, scene `captureScene()` (28 records, 26 parts), taken with `node tools/capture.mjs --label <before|after>` at 1280 x 720; after shots use `--sheet` for the side-by-side page and `--clip 10` for the clip. Same positions, targets, fov and time as before. What each after shot must show:

| Spot | Must show after the remaster |
|---|---|
| `field-overview` (day, 0,1.7,2.5 -> 0.4,1,-6, fov 70) | textured ground and grass with cast shadows from the dummy, crates, rack and lamp post; a block-and-mortar wall; trees with leaf cards not spheres; villa and house with plaster, roof tiles and glass; sky and hills unchanged in hue |
| `dummy-and-sword` (day, 0.3,1.55,-2 -> 1.2,0.6,-3.8, fov 60) | straw body with stalk texture and seam, oak post with grain, sword with brushed steel and a leather grip, axe with a pitted iron head, shield with planks and an iron rim, all three lying in grass with blobs and clearings |
| `wall-crates-rack` (day, fov 65) | at least one `gash` and one `scuff` decal on the wall (the capture tool strikes it once with the sword at 15 N*s before the shot), bevelled plank crates with shadows between them, barrel hoops with rust, hay bale straw, rack with the weapons on it |
| `table-small-things` (day, fov 50) | felt table top, paper cards with edge wear, glazed mug with a dark coffee surface, wooden chess board with turned pieces; the chair's oak grain; no flat green |
| `kingdom-plaza` (day, Kingdom on, formation turned -32 deg, fov 80) | trodden dirt plaza with a worn ring and the grass edge, the Master Builder in a linen tunic with cloth folds and a straw hat beside the player, the stall with a striped canvas awning, house, farm furrows and the castle in fog beyond |
| `sunset-horizon` (sunset, 0,1.6,0 -> 32,6,-100, fov 70) | the sun at 5 degrees with the kept glow, long shadows from the lamp post and house, warm fog over the hills, the lamp post lit with its halo, the crates rim-lit on their edges |

Clip subject (10 s, `--clip 10`, camera at spot `dummy-and-sword`):
- 0.0-1.5 s: a sword summoned into view at arm's length (materialize, 1.2 s, seam and motes);
- 1.5-4.0 s: the sword swung into the dummy (wisps in the air, landing in the grass);
- 4.0-6.5 s: the sword swung into the stone wall (sparks, a scuff where it hit);
- 6.5-10 s: the axe thrown at a crate, sticking by its bit with a gash under it, the crate shaking 2 cm.
Before and after use the same spot list, viewport, time presets and scene; a spot that cannot be reproduced after the remaster is a bug in the remaster, not a reason to move the camera.

## 10. Tier budgets

Names from `js/dot3d/tiers.js` (`quest`, `tablet`, `laptop`; `detectTier`, `?tier=` override). Measured on the device; headless fps is evidence only.

| Budget | quest (Quest 2, 72 fps) | tablet (Galaxy Tab S4, 30 fps) | laptop (i5-1135G7 Iris Xe, 60 fps) |
|---|---|---|---|
| triangles on screen | 300,000 | 500,000 | 1,500,000 |
| draw calls | 150 | 250 | 600 |
| texture memory | 48 MB (1K sets, 256 px procedural) | 64 MB | 160 MB (2K sets, 512 px procedural) |
| shadow map | 1024, 14 m radius | 1024, 14 m | 2048, 22 m |
| particles / decals | 600 / 48 | 900 / 64 | 2500 / 128 |
| grass blades / clumps / flowers | 20,000 / 9,000 / 1,400 (field `low`) | 20,000 / 9,000 / 1,400 | 60,000 / 26,000 / 3,200 (`high`) |
| point lights active | 4 | 8 | 16 |
| pixel ratio / XR framebuffer | 1.0 / 1.0, fixed foveation 0.5 | 1.5 | 2.0 |
| post | none | none | none this pass (bar allows it; nothing here needs it) |

Cut order on Quest if 72 fps is missed, measured at spot 1 with the full capture scene: (1) grass shadow receive off, (2) leaf card translucency off, (3) model triangle caps halved by swapping to the sculpt for buildings beyond 40 m, (4) particles 400, (5) blades 14,000. The Tab S4 follows the same list from (2). Never cut: textured materials, cast shadows from parts within 8 m, materialize, contact effects at the hit point.

## 11. Kingdom skin and classroom

Kingdom mode (`js/world/kingdom.js`, `js/core/kingdom.js`) keeps its rules, advisors (Master Builder, Lord Steward, Marshal of the Realm), slots, villager count (10), walk speeds (0.9-1.4 m/s), stops and name plates. Visual changes only:
- Plaza: the 9 m disc becomes trodden dirt (section 4 `dirt`) with a worn ring at 6-8 m, a soft grass edge, 6 cart-rut decals and a trampled-grass band 1 m wide at the rim (clearing strength 0.6 there, 1.0 inside).
- Advisors and villagers: the `peasant` family body with cloth tunics (fold normal map), leather belts, skin `#d8a77c`, straw or felt hats, and a 2-frame-per-step walk (legs swing 25 degrees, arms 15) in place of the 4 cm bob; the Lord Steward's robe in deep red `#7a1f2b` wool; the Marshal with a steel helm.
- Name plates become hanging wooden boards (oak, carved text in `#f3e3b5`), same size 1.1 x 0.24 m, same emissive flash when an advisor speaks.
- Buildings (castle, tavern, chapel, blacksmith, market stall, farm field) take the section 4 families; the tavern and blacksmith get chimney smoke (the smoke emitter at 1/s), the forge a 10 cd `#ff8a3c` light at night, the stall a striped canvas awning.
- The aim ring stays `#f3d36b`.
The classroom (Requiem, `scratch/requiem-classroom-20261024`) is last by the owner's words and is not designed here; it gets its own bible after the field and Kingdom ship.

## 12. Owner art needed

All GLB, 1 unit = 1 m, base at y = 0, front +Z, one PBR material set at 1024 px (2048 ok, downscaled per tier), triangle cap as given. The owner exports from Meshy or approves the free-model stand-in named.
- training dummy, 0.7 x 1.82 x 0.5 m, straw body on an oak post, <= 12k tris (no free stand-in; highest priority).
- sword 0.28 x 1.05 x 0.04 and wooden sword 0.16 x 0.95, <= 6k each (free stand-ins: `polyhaven/saber`, none for wooden).
- axe 0.25 x 0.745 (stand-in `polyhaven/hatchet`), shield 0.626 round with iron rim (no stand-in), spear 2.0 m (no stand-in), <= 6k each.
- crate 0.9 m cube with bevelled planks, barrel 0.6 x 0.9, hay bale 1.2 x 0.5 x 0.6 (sizes from the sculpt), weapon rack 1.32 x 1.375 x 0.5, archery target 1.2 x 1.61, <= 12k each.
- card table 0.9 m, chair, coffee mug 0.1 m, chess board 0.4 m with pieces (stand-in `polyhaven/chess-set`), deck of cards; <= 8k each.
- market stall 3.4 x 2.9 x 2.65, lamp post 0.5 x 3.79, campfire ring (stand-in `polyhaven/fire-pit`), <= 12k each.
- peasant body 0.62 x 1.72 x 0.52 rigged with idle and walk (3 tunic variants by texture), <= 10k; or approval of the improved sculpt in section 11.
- castle 16 x 15.3 x 16 (<= 60k), villa 14.18 x 9.04 x 11.98 (<= 40k), house 7.84 x 6.92 x 7.35 (<= 40k).
- tree and pine tree trunks (<= 4k) if the owner wants his own; otherwise the sculpt with bark and leaf cards stands.
- Approval of the objaverse CC BY models (attribution line on the Menu's credits panel) or a no.

## 13. Scope cut

Out of this remaster, and why:
- Any rule, parser, catalog, bridge or save change: the finish line says every name, alias and saved room still works; the cheapest way is to not touch them.
- Breakable crates and destructible buildings: new physics scope; the owner asked for marks and sticking, not demolition.
- Cloth simulation: awning and flag stay vertex-animated; a solver costs Quest frames for a background detail.
- Water simulation for pond and fountain: textured planes with a scrolling normal map; same reason.
- Rigged facial animation on advisors: name plates and nods already carry who is speaking.
- Post-processing (bloom, SSAO) on any tier: nothing in the six spots needs it, and Quest cannot afford it.
- A downloaded HDRI sky: the field's own sky dome and preset hues stay; the PMREM is baked from them, so no file download and no hue drift.
- Re-lighting or restyling the HUD, launch panel or menus: the owner's complaint was the world, not the UI.
- The classroom skin: last by the owner's words; its own bible later.
- The ~290k parts-bin family records beyond inheriting family materials: 225 templates get the look; per-record art is not possible.
- Replacing the hands, grip, two-hand holds, hit haptics, sounds, dummy rig, multi-device ownership or stick: all passed; a pass closes the step.
- Any purchase, Meshy generation by an agent, or camera/microphone activation: owner rules.

## 14. Finish line

Checklist, all must be true: (1) a person opening the candidate on the laptop sees at spots `field-overview`, `dummy-and-sword`, `wall-crates-rack`, `table-small-things`, `kingdom-plaza` and `sunset-horizon` no untextured flat-color part and a cast shadow under every yard part, and the before/after sheet from `tools/capture.mjs --sheet` shows the same six framings with the after shots matching section 9. (2) Saying "AI, spawn a villa" and "AI, spawn a coffee mug on the card table" shows each rise out of a glowing seam with motes, the villa in about 2 s with a ground ring and a dust settle, the mug in about 1.2 s with a pinch of motes and no ring, and neither pops. (3) Swinging the sword into the stone wall throws sparks and leaves a scuff at the spot hit; into a crate leaves a gash; into the dummy sends straw into the air that lands and lies on the ground; throwing the axe into a crate makes it stick with a gash under the bit. (4) The 30 priority parts of section 5 are real models or owner-approved sculpts, each standing on the ground at its catalog size, and every one of the 139 catalog names and their aliases still spawns ("AI, spawn a hatchet" gives the axe). (5) A room saved before the remaster loads with every part in its place and the game's existing saves, settings and bridge config are untouched. (6) Kingdom mode shows a trodden dirt plaza, advisors and villagers in cloth tunics walking with swinging legs, a striped stall awning and chimney smoke from the tavern. (7) In the Quest 2 the headset self-test report shows 72 fps (p95 frame time 13.9 ms or better) standing at spawn in the capture scene for 60 s, and walking into the physics wall stops the player. (8) At night the lamp post and campfire light the ground around them and the rest of the field is cool blue; at sunset the shadows are long and warm. (9) The live folder is swapped only after Justin says the kids are off the headset, the Desktop shortcut opens the game, and Justin has played it himself and not rejected it.

## 15. Build order

Each step is done in this candidate folder, closed by its own check of 15 minutes or less, and leaves the previous steps' checks passing. Checks that render use `node tools/capture.mjs` (headless Edge, laptop tier) unless marked heavy.

1. It launches and the loop runs once. Open `index.html?mode=physics&capture=1`, confirm the before set exists at `captures/before/` with `report.json` showing 0 console errors, then summon one part and hit the wall once.
   Files: none.
   Check: `node tools/capture.mjs --label baseline-r2` finishes with `consoleErrors: []` and fps >= 55.
2. Look pipeline on the existing proxies. `js/main.js` calls `applyLook` (AgX, exposure, 4 PMREMs from the presets, keyLight false); `js/world/field.js` turns on `sun.castShadow` with the fitted following shadow box and tier map size; `js/parts/build/kit.js` `mat()` returns section 4 family materials from `createMaterials` (existing recipes only in this step: wood, rock, dirt, plaster, metal, carpet, glass, emissive) keeping `userData.kind`; `groundShadows` on every built part.
   Files: `js/main.js`, `js/world/field.js`, `js/parts/build/kit.js`.
   Check: capture `after-step2`: spots 1-4 show textures and shadows; 0 console errors; laptop fps >= 60; `tests/parts.test.mjs` and `tests/physics-*.test.mjs` pass unchanged.
3. New material recipes. Add `plank`, `straw`, `iron`, `blocks`, `cloth`, `leather`, `ceramic`, `paper`, `leaf`, `bark` to `RECIPES` in `js/dot3d/materials.js` (additive) and map the kit kinds and part families to them in `kit.js`.
   Files: `js/dot3d/materials.js`, `js/parts/build/kit.js`, builders that pick a family by part (`combat.js`, `structures.js`, `nature.js`, `leisure.js`, `office.js`, `kingdom.js`, `props.js`).
   Check: a Node test that `createMaterials(THREE).get(name)` returns map, normalMap and roughnessMap for all 19 names and that no built-in part builds with a map-less MeshStandardMaterial; capture spot 2 shows straw and brushed steel.
4. Per-time lighting. Exposure, env intensity, fog colors, moon, lamp post and campfire point lights with the active cap, halos as decals.
   Files: `js/world/field.js`, `js/parts/build/structures.js` (lamp post), `js/parts/build/nature.js` (campfire), `js/dot3d/decals.js` (kind `glow`).
   Check: capture spot 6 plus `?time=night` and `?time=dawn` overrides at spot 1; 0 errors; fps >= 60.
5. Materialize. Duration and band formulas, shimmer bursts through `createParticles`, ring rule, dust settle, in-hand variant, seam point light, sculpt-then-model swap under the band.
   Files: `js/world/phase.js`, `js/main.js` (particles handle to phase), `js/play/interact.js` only if the in-hand reveal needs the grip.
   Check: `node tools/capture.mjs --clip 10` of "spawn a villa" then "spawn a coffee mug on the card table"; frame count where the band is visible matches 2.08 s and 1.2 s within 10%; `tests/objects.test.mjs` passes.
6. Effects with causes. Tier pools in `js/main.js`; `straw` and `grass` materials in the collider registration and `defaultRules`; kinds `wisps`, `ember`, smoke tint; decal kinds `gash` and `blob`; campfire emitter; throw-landing clearing pulse.
   Files: `js/dot3d/particles.js`, `js/dot3d/decals.js`, `js/dot3d/vfx-textures.js`, `js/physics/colliders.js`, `js/main.js`, `js/parts/build/nature.js`.
   Check: `tests/physics-hits.test.mjs` and `tests/physics-stick.test.mjs` unchanged and passing; a new Node test feeds a 15 N*s steel-on-wood contact and sees one `gash` decal and >= 10 chips, a 3 N*s hit on straw >= 4 wisps and no decal; capture clip of the section 9 subject.
7. Model loader and manifest. `js/parts/build/models.js` (GLTFLoader from the vendored three examples, cache, re-base, scale-to-size with the 15% rule, grip alignment, material family override, instancing), `assets/models/MANIFEST.json`, a `tools/manifest-check.mjs`.
   Files: those plus `js/parts/build/index.js` (model-first, sculpt fallback).
   Check: `node tools/manifest-check.mjs` loads every manifest GLB in Node (gltf header parse plus bbox from the accessor min/max), asserts size within 15%, base within 10 mm, triangles under cap, sha256 matches; a missing file degrades to the sculpt with one warning in a headless capture.
8. Priority models 1-10 (sword, axe, shield, training dummy, wooden sword, dagger, katana, spear, crate, barrel) from owner exports or the named free stand-ins.
   Files: `assets/models/*`, `assets/models/MANIFEST.json`.
   Check: manifest check; capture spots 2 and 3; `tests/physics-grip.test.mjs` passes (grip points unchanged); the models' share of the scene's triangles under 100k and the rendered total at spot 1 recorded with its breakdown in `report.json` (the original "under 300k on-screen" figure was written before the field's grass existed; the field alone is far above it, so that budget moves to the tier pass, step 13: Command, Oct 26).
9. Priority models 11-20 (hay bale, weapon rack, archery target, bench, lamp post, campfire, card table, chair, coffee mug, chess board).
   Files: `assets/models/*`, `assets/models/MANIFEST.json`.
   Check: same as 8 with spots 1, 3, 4. (Done Oct 27, Command: eight ship; bench and campfire keep their sculpts with the measured reasons in the manifest, both to be pulled again with step 10. The weapon rack ships under a recorded 15,000 cap, see its `capNote`; the models' share of the scene's triangles is gated under 150k for this step, since step 8's 100k covered its ten slots and the eight new models in the same scene bring it to about 133k (the Quest budget is settled at step 13); the small things are grabbed from a hand hovering above them, because a scripted hand teleported onto the table shoves it.)
10. Priority models 21-30 (deck of cards, whiteboard, market stall, peasant body, castle, house, villa, tree, pine tree, farm field).
   Files: `assets/models/*`, `assets/models/MANIFEST.json`, `js/parts/build/nature.js` (leaf cards on the tree sculpt if no model).
   Check: same with spots 1, 5, 6; draw calls at spot 1 under 150 with instancing.
11. Long tail. Bevels and smooth normals in `kit.js` primitives, family materials across the remaining 109 builders, Astra's named flaws from `scratch/training-room-3d-audit-20261024` fixed where touched.
   Files: `js/parts/build/*.js`.
   Check: a Node test builds all 139 parts and every alias through `getMeta`, asserts no map-less material and every root's bbox min y within 10 mm of 0; `tests/parts-catalog.test.mjs` passes.
12. Kingdom skin. Plaza dirt with ring and ruts, figures with cloth and walk cycle, name boards, awning, chimney smoke, forge light.
   Files: `js/world/kingdom.js`, `js/parts/build/kingdom.js`.
   Check: capture spot 5; `tests/kingdom.test.mjs` passes unchanged.
13. Quest fps pass (heavy job: `heavy.lock`). Tier cuts in section 10 order until the headset self-test (`js/selftest.js`, report through `bridge/check-headset-report.mjs`) shows 72 fps at spot 1 for 60 s.
   Files: `js/dot3d/tiers.js` only if a budget number must change, `js/world/field.js` quality, `js/main.js`.
   Check: `node bridge/check-headset-report.mjs` on the saved headset report reads p95 <= 13.9 ms and 0 errors; an old saved room loads on the headset.
14. After sheet, saves and swap. `node tools/capture.mjs --label after --sheet --clip 10`; `asset-guard` hashes of the live folder's art and saves before the swap; Desktop shortcut test launch; swap only on Justin's safe-play word.
   Files: none in the candidate; the live folder only at the swap.
   Check: the sheet exists with six pairs, an old save loads in the candidate, the shortcut opens the game, the live folder's hashes match the backup.

## 16. Open questions for the owner

1. Is the headset a Quest 2 (72 Hz)? Assumed yes; a Quest 3 would be measured at 72 Hz too unless he says 90.
2. Where are his Meshy exports (folder path)? Assumed none yet; steps 8-10 proceed on the free stand-ins and leave the owner slots empty in the manifest.
3. May the CC BY objaverse models ship with an attribution line on the Menu's credits panel? Assumed yes.
4. Should the advisors and villagers be rigged humans (his Meshy export) or the improved wooden-figure sculpts? Assumed the sculpts for this pass.
5. Does the straw training dummy stay straw-on-a-post, or does he want a padded canvas dummy? Assumed straw (it is what sticks).
6. Does the trodden-dirt disc under yard parts suit him, or should grass run right up to everything? Assumed the disc.
7. The Poly Haven texture set names are from memory; if any is gone, may the builder pick the nearest CC0 set without asking? Assumed yes, recorded in the manifest.

Claude (Fable 5.1, game-designer agent) for Claude (Command), Oct 26 2026
