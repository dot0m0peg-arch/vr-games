# Training Room character parts bin — 80,000 editable presets

The character generator writes into the active laptop bridge parts bin, not GitHub Pages assets:

- Windows: `%APPDATA%\dot-training-room\parts`
- `character-library/index.json`: 80,000 indexed creature-name records and batch pointers
- `character-library/mythical-00.catalog.json` to `mythical-03.catalog.json`: 20,000 mythical character templates
- `character-library/air-00.catalog.json` to `air-03.catalog.json`: 20,000 aerial real-creature presets
- `character-library/land-00.catalog.json` to `land-03.catalog.json`: 20,000 terrestrial real-creature presets
- `character-library/water-00.catalog.json` to `water-03.catalog.json`: 20,000 aquatic real-creature presets
- `character-starters.catalog.json`: first 80 recognizable mythical archetypes, eagerly registered in the normal parts bin
- `character-common-{air,land,water}.catalog.json`: recognizable common creatures eagerly registered

**Different creature characters versus distinct species:** the mythical set combines genuine folklore creature types with imaginary biome/job archetypes (e.g. a marsh goblin scout). The real sets contain GBIF-accepted species by their common or scientific names plus distinct editable life-stage, posture and activity presets (juvenile, resting, feeding, alert, travelling, etc.) for those species. They are 20,000 character presets per habitat, **not** 20,000 different biological species per habitat. These are fast-to-render 3D primitive **proxy models**, not anatomically accurate GLB scans. Placeholder poses are indicative rather than biologically verified species-specific behaviors.

## In-game lookup

The bridge provides `GET /api/characters/resolve?q=<spoken request>` with room-key authentication. It loads the small name index, returns one requested blueprint from a single 5,000-item batch, and caches at most two batches. This avoids transferring all 80,000 meshes/blueprints in one `GET /api/parts` response and loading them into the headset.

The browser runner checks a spawn command against this lookup before asking the LLM. Example: **"spawn a goblin with a freckle"** resolves the reusable `goblin` base and adds one tiny dark sphere at the cheek. **"spawn a marsh goblin scout to my left"** resolves that whole archetype. Common aerial, land and aquatic creatures are searchable; fetched species names (including scientific binomials) also work. Requested figures may be moved, recolored, resized, or given other geometry changes with the game commands. Their default walking, flying, and swimming motions follow the appropriate group. The bridge must be running; the standalone hosted site has only built-in and pre-bundled part names.

No paid API/service is used at game runtime. Taxonomy was downloaded from GBIF (Global Biodiversity Information Facility) during generation, then stored locally, with real species taxonomy keys kept in the blueprints' `desc` fields. Basic well-known creature names are curated seeds rather than claimed to be GBIF-verified species. The importer does not deliberately create fake scientific species names.

## Rebuild / check

From the `vr-games` repo, with Python and Node installed:

```powershell
python tools/character_catalog.py --output "$env:APPDATA\dot-training-room\parts" --group mythical
python tools/real_creature_catalog.py --output "$env:APPDATA\dot-training-room\parts" --group all
node --test games/training-room/tests/character-library.test.mjs
node --test games/training-room/tests/*.test.mjs
```

Each generator writes one atomic .catalog.json every 5,000 creatures and updates the index only after the catalog exists. **Do not regenerate or delete the bin while guests are using the shared room.** The bridge picks up eagerly loaded starters on its normal file rescan; the on-demand route requires a bridge restart after updating the server code.

The index and all lazy catalogs are generated runtime data stored outside the repository; the two Python scripts and lazy lookup code in this repository can reproduce the library.
