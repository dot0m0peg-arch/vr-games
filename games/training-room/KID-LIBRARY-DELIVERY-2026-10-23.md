# Training Grounds: verified missing-content delivery — 2026-10-23

## Scope and delivered inventory
- Read PARTS-BIN-AUDIT-HANDOFF-2026-10-23.md and inspected the LIVE root bin, character index, built-in registry, loader, voice route, and working-tree changes.
- **17,231 additional canonical 3D blueprint records** in **eight** new, indexed, SHA-256-checksummed checkpoints (maximum 2,500 records per batch).
- Sources: **15,206** newly imported accepted GBIF species, **444** manually curated real-world animal/group names, **654** independently named familiar non-animal things, and **927** further familiar wildlife/botanical names. Of all records, **15,266** have distinct accepted GBIF species IDs; others are named common groups or independently recognizable non-biological things.
- Specific categories: **15,642 aquatic**, **179 mammals**, **126 birds**, **115 reptiles**, **211 insects**, **66 arachnids**, **43 amphibians**, **157 plants**, **7 algae**, **21 fungi**, **2 protists**; plus **8 land-classed animals** from the earlier curated aquatic/amphibian pass. Independent play/worldbuilding entries include **94 extinct creatures**, **60 trucks/equipment**, **85 vehicles**, **45 rides**, **29 spaceships**, **23 robots**, **65 magical props**, **91 toys**, and places/scenes/buildings.
- Prior-inventory duplicate exclusion: **0 exact normalized name/alias collisions**, including the original 80,000 character presets and 126 built-ins; all new canonical names are distinct, and all new GBIF taxon IDs are unique.
- Conservative cleanup merged obvious synonymous names into aliases (e.g. T-rex → tyrannosaurus rex; fire engine → fire truck; sea monkeys → sea monkey), and removed an erroneous goblin-shark egg case and a life-stage-only sea turtle hatchling before counting.
- Axolotl and pistol shrimp were ALREADY PRESENT in **aquatic-01.catalog.json**; Venus flytrap already exists in household-0005.catalog.json. These existing objects were verified but never double-counted.

## Exact output locations
- Repository: C:\Users\dot0m\Documents\vr-games
- Live new library: %APPDATA%\dot-training-room\parts\kid-library\
- index.json: **17,231** record references and spoken aliases, **1,696,478 bytes**. Batch data loads only on a match; two batches at most remain cached.
- batch-0000.json through batch-0007.json: eight saved blueprint batches. manifest.json has final counts, individual SHA-256 checksums, source mix, synonym changes and the wildlife checkpoint.
- _before-semantic-cleanup/: snapshot of OUR original 7 batches; unindexed and never served.
- Backend: games/training-room/bridge/kid-library.mjs and minimal additions to bridge/server.mjs, retaining the original character-library route as fallback.
- Source/validators: tools/generate_kid_library.py, tools/finalize_kid_library.py, tools/generate_kid_nature_additions.py, tools/verify_kid_library.py, tools/verify_kid_spawns.mjs; unit tests in games/training-room/tests/kid-library.test.mjs.

## Verification
- Full input-vs-new catalog audit: all 17,231 indexed names match their batch slots; zero exact collisions with legacy catalogs, character names, aliases or built-in parts; all 8 SHA-256 checksums matched; 15,266 unique GBIF keys; no missing files.
- Full Node parser validation: **17,231 / 17,231** blueprints passed normalizeBlueprint() independently.
- **20** representative familiar spoken request, modifier, procedural-build and pre-existing-favorite checks passed. Samples: fin whale, goblin shark, blue dragon sea slug, giant isopod, sea angel, T-rex, fire engine, spaceship, volcano, magic wand, shoebill, platypus, Gila monster, peacock spider; axolotl/pistol shrimp and Venus flytrap sourced from originals.
- New lazy resolver uses about **1.7 MB** for its on-disk index, and a repeat warmed Node lookup measured **0.136 ms** on this run (not a headset/browser performance measurement).
- Final full game Node suite re-run completed with exit code 0: **447 tests; 445 passed, 0 failed, 2 skipped**.
- No git commit or push; no bridge restart or replacement of existing catalog data; other producer threads' uncommitted files preserved.

## Limits and follow-up
- **35 coarse 3D primitive geometry signatures**, shared across taxa and concepts, not 17,231 species-accurate modeled meshes. This task is an IDENTITY / CONTENT foundation with reusable proxy geometry; geometry refinement is independent future work.
- Large numbers of accepted species necessarily have Latin names rather than child-friendly English names. The 927 extra nature names and other curated names improve natural spoken coverage, but should not be portrayed as exhaustive.
- Existing eager root-bin catalog (~192,714 original records) is unchanged, and original aquatic fiction-heavy entries are preserved. The new kid library is separate to avoid increasing eager GET /api/parts payload.
- The currently RUNNING bridge was not restarted to avoid impacting other threads; the edited server will use the new lazy route on its next planned restart.
- The user's original approximate +100,000 content target is not reached. **True physically delivered count is 17,231**, not 100,000 and not 17,231 unique 3D silhouettes. Do not fabricate additional counts.
- Before follow-on changes, re-read live files and this manifest, maintain canonical IDs/aliases, recompute checkpoints after geometry changes, and avoid altering the original producer files.
