# Training Grounds / Training Room — parts-bin audit and next-thread handoff
Audited 2026-10-23 on Desktop Commander device **justin** (device ID: 67ae3b31-e86a-4319-9ed1-46a1e8b18ca0). INSPECTION ONLY: no existing bin or program files changed during this audit. This file is the handoff.

## Mission
User requests ~100,000 ADDITIONAL, nonduplicate, recognizable, kid-requestable 3D summonable objects/creatures for the game, accounting for all existing inventory and all concurrent producer threads. User explicitly asked to inspect first, pass findings to a fresh context/thread, and then generate; no generation should be claimed yet. User especially objects to the 90,000 aquatic batch containing just 248 real animals and 89,752 fictional combinations; prioritize biodiversity and real animals above made-up composites. Fiction must be expressible by natural spoken prompts (e.g. "swordfish with a hippopotamus butt"), no invented gibberish taxonomy. No color-only, pose-only, size-only, or named-number-only 'different objects'. Preserve existing files, don't step on uncommitted work.

## Locations / interface
Repo: C:\Users\dot0m\Documents\vr-games
Game: C:\Users\dot0m\Documents\vr-games\games\training-room
Active parts bin: %APPDATA%\dot-training-room\parts (C:\Users\dot0m\AppData\Roaming\dot-training-room\parts).
Core loader: games/training-room/bridge/parts-bin.mjs
Lazy character resolver: games/training-room/bridge/character-library.mjs
Browser character resolver: games/training-room/js/parts/character-spawn.js
Core voice runner: games/training-room/js/runner.js
Server route: games/training-room/bridge/server.mjs, GET characters/resolve
Existing scripts: tools/household_catalog.py, tools/food_catalog.py, tools/character_catalog.py, tools/real_creature_catalog.py, plus aquatic and weapons generators in the live parts directory.
Docs: games/training-room/ARCHITECTURE.md and CHARACTER-LIBRARY.md.
Shape format: {name,aliases,desc,category,holdable,parts:[{shape,p,s,r,color,mat}]}; shape only box/sphere/cylinder/cone/capsule/torus. Existing procedural geometry is low-detail 3D proxy, NOT a photorealistic mesh.

## Actual saved content counts — PARSED, not inferred from requests
68 .catalog.json files, 272,714 blueprint records:
- aquatic: 90,000, 18 files of 5,000; _aquatic-manifest.json explicitly confirms 248 "real originals" and 89,752 fictional composites (with 360 base species for composite pairing, not 360 unique real original records).
- food: 50,000, 10 files of 5,000; manifest says 7,279 conventional foods and 42,721 creative foods.
- weapons: 50,000, 15 files; manifest says 50,000 unique names, checkpoints per 7,000.
- lazy indexed character library: 80,000, 16 files (20,000 mythical, 20,000 air, 20,000 land, 20,000 water) and character-library/index.json with 80,000 entries.
- eager real common creature starter catalogs: 313, 3 files.
- eager mythical starter catalog: 80, 1 file.
- household: only 2,321 ACCEPTED, 5 files. Earlier 50,000 goal NOT delivered; household audit shows just 439 distinct geometry signatures.
- built-in game part registry: 126 parts; these are separate from 272,714 file blueprints.

Cross/within catalog name audit: 272,261 unique normalized blueprint names; 453 repeat-name occurrences (majority intentional between common-creature eager starters and lazy character entries: 313, and mythical starters vs lazy index: 80). Other overlaps include common creatures vs food (44), aquatic vs lazy characters (11), etc. This counts duplicate normalized names, NOT geometry similarity. Audit found no invalid .catalog.json files among the 68.

Separate water-character 20,000 presets contain about 9,100 BASE names (remaining 9,100 juvenile poses + 1,800 large adult poses); mainly fish (GBIF accepted species identifiers among them), NOT 20,000 unique aquatic species. Indexed names include Latin species for obscure fish; recognizable common-name coverage is weak. This doesn't excuse the 90k aquatic real/fake imbalance. An exact spoken name may be missing even if the organism exists under another accepted name.

## Confirmed major exact-name holes from a representative 325-name candidate scan
The scan is ONLY exact names/aliases (not a definitive biological absence): 
- Aquatic mammals: fin whale, gray whale, right whale, beluga whale, spinner dolphin, harbor porpoise, elephant seal, harbor seal, fur seal.
- Aquatic reptiles: leatherback sea turtle, loggerhead sea turtle, green sea turtle, sea snake, marine iguana, sea krait, gharial.
- Aquatic invertebrates: giant isopod, sea angel, sea butterfly, sea pen, sand dollar, geoduck, bobbit worm, basket star, brittle star, salp, sea squirt, blue dragon sea slug, sea spider.
- Fish spoken names: oarfish, coelacanth, goblin shark, frilled shark, blobfish, anglerfish, basking shark, mudskipper, weedy seadragon, lamprey, remora, hagfish.
- ALL 25 tested recognizable prehistoric animals missing by exact name: T. rex, triceratops, stegosaurus, brachiosaurus, velociraptor, ankylosaurus, spinosaurus, mosasaurus, plesiosaurus, ichthyosaurus, megalodon, trilobite, ammonite, pteranodon, mammoth, etc.
- ALL 27 tested space/sci-fi names missing: spaceship, space shuttle, astronaut, alien, UFO, space station, rover, space suit, asteroid, meteor, comet, planet, galaxy, robot dog, teleporter, etc.
- ALL 34 tested natural place/world names missing: volcano, waterfall, river, cave, glacier, iceberg, mountain, coral reef, island, shipwreck, jungle, desert, haunted house, underwater city, etc.
- Playground: 28 of 30 tested missing (playground slide, swing set, seesaw, monkey bars, splash pad, bouncy castle, ball pit, carousel, Ferris wheel, roller coaster, etc).
- Utility vehicles: 38 of 44 tested missing (fire truck, ambulance, excavator, tractor, garbage truck, submarine, airplane, helicopter, train, ice cream truck, etc).
- Magic/story props: all 28 tested missing (magic wand, spellbook, treasure chest, cauldron, crystal ball, flying broom, fairy house, time machine, giant beanstalk, etc).
This is a preliminary exact-name GAP sample, not a comprehensive semantic collision audit.

## Important architecture/performance risk
bridge/parts-bin.mjs eagerly scans all root .catalog.json and generated/*.catalog.json, loading blueprint arrays into memory. GET /api/parts uses bin.manifest() and sends ALL eager blueprints; adding 100k more there directly risks huge network transfer, browser memory, startup and local model slowdown. The 80k character library correctly uses lazy index + GET /api/characters/resolve to fetch one blueprint. A generic lazy library/index for new categories should be explored BEFORE bulk generation. Also bridge/llm.mjs catalogText has compact mode capped at 120 custom names, while its noncompact mode enumerates a much larger catalog. Measure actual browser/bridge latency and verify name resolution rather than assuming large catalogs are playable. Be careful: game has uncommitted code changes from other threads.

## Work discipline for next thread
1. Re-inspect LIVE bin, built-ins, and git status (other threads may still be writing). Confirm source categories and input schema. Do not regenerate, overwrite, delete, restart bridge, or alter any other thread's output.
2. Build normalized canonical name + aliases exclusion over ALL groups, including built-in names, with spelling/plural/synonym checks and semantic/geometry similarity screening. Preserve provenance by source file. Check at every incremental commit; no duplicate IDs/names. Show true different archetypes, not superficial permutations.
3. Prioritize many verified REAL organisms by multiple habitats, especially non-fish marine biodiversity, plus common-name voice aliases. Use reputable taxonomy (e.g. WoRMS/GBIF/OBIS) for accepted species and store accepted ID/scientific name; no fabricated species presented as real. Real originals should come FIRST, with test prompts a documentary-watching kid would naturally say. Don't count juvenile/pose/size/color versions as new species. Avoid treating scientific name lists alone as sufficient for kids.
4. Then fill high-value completely missed categories: dinosaurs & extinct fauna, playground rides, vehicles, spaceships/space equipment, natural landforms and biomes, magic props, toys, school/play items, robots, themed buildings/scenes, familiar pop-culture-neutral archetypes (respect protected IP), insects and small wildlife, construction equipment, crafts and effects.
5. Plan and implement lazy searchable delivery for large catalogs; ideally one generic resolve route serving a blueprint from one indexed batch. Preserve game behavior, voice parser, modifiers, and bridge memory ceiling. Include family-friendly natural language name matching.
6. Output truly distinct 3D procedural blueprints. Work in atomic 2,500–5,000-item files with manifest, category coverage, SHA-256, counts, resumability, collision log and checkpoints. NEVER inflate counts with renames or cosmetic variants. Test representative prompts with exact voice names and modifiers. If genuine supply less than nominal target, report actual number instead of lying.
7. Verify parser/resolve, GET parts size/memory, browser performance, and node --test games/training-room/tests/*.test.mjs; preserve all existing uncommitted changes; avoid Git push/commit unless explicitly authorized.
8. Report delivered records vs verified unique archetypes, biological sources, examples of kid-speak, collisions skipped, exact files written, and tests. Do NOT claim 100,000 created until verified.

This audit did NOT create the extra 100,000 blueprints and did NOT fix the marine catalog. It prepared reliable directions for a new context to do the real work.
