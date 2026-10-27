# Real models for catalog parts

LOOK-BIBLE.md section 5 and build order step 7. The game builds every part's family sculpt first (`js/parts/build/*.js`);
that sculpt is the collider source and the fallback look. `js/parts/build/models.js` then loads the part's GLB named
here and swaps it in, fitted to the catalog size. Physics never changes with a model.

## MANIFEST.json

```json
{ "version": 1, "models": [
  { "part": "katana", "file": "katana.glb", "status": "active",
    "source": "https://polyhaven.com/a/antique_katana_01", "license": "CC0", "author": "Poly Haven",
    "rotate": [0, 0, 0], "handle": null, "offset": [0, 0, 0], "material": null, "cap": 6000,
    "sha256": "...", "triangles": 1234, "textures": [{ "w": 1024, "h": 1024 }], "size": [0.08, 1.02, 0.07] }
] }
```

- `part`: a catalog name from `js/parts/meta/*.js` (aliases resolve to it already; "hatchet" spawns the axe).
- `status`: `active` (loaded), `awaiting-owner` (a slot for the owner's Meshy export; `file` null), `rejected` (kept with a `rejected` reason; never loaded).
- `license`: `CC0`, `CC-BY-4.0` (attribution line goes on the Menu's credits panel) or `owner` (his own export). `source` is the page or folder it came from.
- `rotate` (degrees, X then Y then Z) turns the model so its largest axis matches the catalog's; `tools/manifest-check.mjs --scan <folder>` suggests it.
- `handle` (metres, in the fitted, re-based model) is the point a hand holds; the model is shifted so it lands on the catalog `grip.p`. Null keeps the base on the ground.
- `offset` nudges the fitted model in metres. `material` replaces the model's materials with a kit family (`plank`, `steel`...) for an untextured model.
- `cap`, `sha256`, `triangles`, `textures`, `size`: filled by the tool with `--write`; a plain run fails when they disagree with the file.
- `tolerance` (step 8; metres per axis, at most 120 mm, never on the largest axis) widens the 15% / 30 mm rule for one entry whose real shape differs from its sculpt box by a guard or a head (a crossguard thicker than the sculpt's blade slab, a spear head wider than the shaft slot). It needs a `fitNote` saying why. Colliders are still the sculpt's, so the cap is small on purpose: a body that is twice its collider stays rejected (the Meshy scarecrow dummy, 1.57 m arms on a 0.7 m slot, is the recorded example).
- `rig` (step 8): `{ "split": <metres up from the ground> }` for a part that js/physics/rig.js splits for a swing rig (the training dummy). models.js cuts the model's triangles at that plane; the top joins the live `rig:swing` group the physics side poses, the rest stays planted. The rig's pivot, bodies and colliders are the sculpt's and do not change. Without `rig.split` a rigged part keeps its sculpt.
- `license` `meshy-community`: Meshy's free community catalog. Owner, Oct 26 2026 11:56 AM (Claude Duet transmitter): "These are all licensed. ... it's a catalog that tells you you can use any of it in a paid game. Don't ... verify and test that each one is individually." The catalog is the licence record and there is no per-model check. Command's own decision (not the owner's words): no attribution line is generated for these, since no per-model licence text was read. `source` is the Meshy post.
- `prepared`: what `tools/touchup/catalog_prep.mjs` (PIPELINE) did to the pull before it landed here: node transforms baked into the vertices, upright by principal axes (and flipped when the file stood tip-down), grounded and centred, welded, simplified with meshoptimizer to the slot's cap. The pulls themselves stay untouched in `TrainingRoom-FreeModels\meshy` (raw, 2048 px) and `\meshy-ready` (Claude Duet's Quest copies, 1024 px, the prep's input).
- Step 9 (Oct 27): `prepared` may also say the pull was stretched per axis (`stretch`: the long hay bale onto the squarer bale slot, the card table's legs so its top meets the collider top where things rest), cropped (`keepX`: the ribbons off the archery target's rim) or turned (the mug, handle onto the grip side); the plan with the reasons is PIPELINE `scratch/vr-physics-build-20261025/look9-plan.json`. Textures are downsized to 1024 px in prep from the raw pulls. `cap` set by hand on an entry overrides the default cap and needs a `capNote` (the weapon rack, 14,854 triangles under 15,000).
- `CC-BY-4.0` and Poly Haven `CC0` stand-ins sit beside the Meshy pulls; a rejected entry's `candidate` names what was measured.

Fit rules (`js/parts/build/model-fit.js`, shared by the game and the tool): the largest axis is scaled to the catalog's
largest; the other two must land within 15% of the catalog size or 30 mm, whichever is wider; base within 10 mm of
y = 0; triangles under the cap (held 6,000; yard prop 12,000; building 40,000; castle 60,000; tree 4,000); textures at
most 2048 px (Quest downscales to 1024 at the tier pass); one self-contained GLB, no Draco or meshopt.

## Commands

```
node tools/manifest-check.mjs                 # check every entry; exit 0 only when all are right
node tools/manifest-check.mjs --write         # fill sha256, triangles, textures, size; mark unfitting entries rejected
node tools/manifest-check.mjs --scan C:\Users\dot0m\Documents\TrainingRoom-FreeModels\polyhaven
```

A missing or unreadable file at run time leaves the sculpt in place with one console warning per file (never an error).
Parts whose builder keeps mesh references (text panels, card decks, screens) or that are split for a physics rig keep
their sculpt until a model is designed for them.

Claude (Command), Oct 26 2026.
