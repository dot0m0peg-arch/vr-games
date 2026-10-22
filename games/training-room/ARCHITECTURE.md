# Training Room: architecture and module contract

Training Room is a WebXR "summoning" sandbox: a huge grassy field where the player speaks
("AI, spawn a villa to my left") and objects phase in. It is a virtual office, combat
practice yard and think tank. It runs in two modes:

- **Standalone** (GitHub Pages, any device): built-in rule parser, browser speech recognition
  when the browser has it, typed commands. One player, state kept in the page.
- **Laptop bridge** (`bridge/server.mjs`, zero npm dependencies): the laptop serves the game
  over HTTPS on the LAN, proxies commands to a local model through Ollama (or any
  OpenAI-compatible server), forwards push-to-talk audio to a local Whisper server, serves the
  laptop parts bin, and syncs the headset, laptop and phone in one shared room.

Everything here is plain ES modules. No build step.

## Conventions (every module)

- ES2022 modules, 2-space indent, double quotes, semicolons, short comments only where useful.
- Our own browser modules import three.js by **relative path** to `vendor/three.module.min.js`
  (works in Node tests too). `index.html` has an import map `"three": "./vendor/three.module.min.js"`
  for vendored addons and owner-written parts; same URL, so one three.js instance.
- Pure modules (`js/core/*`, `js/parts/meta/*`, `js/util/emitter.js`, `js/util/ids.js`,
  `js/voice/wav.js`) must not touch `window`, `document` or three.js; the bridge imports them.
- Units: meters, radians in data (degrees only inside part builders/blueprints), +Y up.
- World: flat ground at y = 0 forever. Player spawn at (0, 0, 0) looking toward -Z.
- Yaw: `yaw` is three.js `rotation.y`. Forward for yaw θ is `[-sin θ, 0, -cos θ]`,
  right is `[cos θ, 0, -sin θ]`. An object at O faces a point P when `ry = atan2(P.x - O.x, P.z - O.z)`
  (object fronts face local +Z).
- Part origin: bottom-center of the bounding box; front faces +Z; size in meta matches the
  built mesh within 10%.
- Never `eval` model output. The model can only emit data (intents and primitive blueprints).
- Tests: `node --test games/training-room/tests/*.test.mjs` (Node 22+, no dependencies; use a glob, not a bare directory).

## Data shapes

### Part meta (`js/parts/meta/<category>.js` → `export const metas = [...]`)

```js
{
  name: "card table",            // canonical id, lowercase, may contain spaces
  aliases: ["poker table"],      // lowercase phrases; plural "s"/"es" handled by the lexicon
  category: "leisure",           // structures | nature | office | leisure | combat | custom
  desc: "square green felt table for cards", // short, used in the model prompt
  size: [1.0, 0.78, 1.0],        // [w, h, d] meters at scale 1
  color: "#2f6b3a",              // default primary (tinted) color
  holdable: false,               // can be held in a hand (keep ≤ 2 m long)
  grip: { p: [0, 0.3, 0], r: [-90, 0, 0] }, // holdables: see Grip below
  tip: [0, 0.9, 0],              // weapons: striking point (local coords)
  surface: 0.78,                 // things can be placed on top at this local y; omit if not a surface
  surfaceSize: [0.9, 0.9],       // usable top [w, d]
  hittable: true,                // training dummies/targets wobble and count hits
  writable: true,                // has text (whiteboard, sticky note, sign)
  deck: true,                    // deck of cards behaviors (deal/shuffle)
  screen: true,                  // can show a shared laptop screen / phone camera
}
```

**Grip.** When held, the object is positioned so its local point `grip.p` sits at the WebXR
grip-space origin (center of the fist) and rotated by Euler `grip.r` (degrees, XYZ) relative to
grip space. Grip space -Z runs along the fist toward the thumb, so a tool built upright (handle
along +Y, head on top) uses `r: [-90, 0, 0]`. Default grip: `{ p: [0, h/2, 0], r: [0, 0, 0] }`.

### Builders (`js/parts/build/<category>.js` → `export const builders = { name(opts) }`)

`opts = { color, data, text, seed }` → returns a `THREE.Object3D` built with `kit.js`.
Primary-colored meshes get `tint: true` so color commands can recolor them. Optional hooks on
the returned root's `userData`:

- `update(dt, t)`: animation (flag, campfire flicker).
- `setText(text)`: writable parts.
- `setDeck(data)`: deck/cards visuals from `record.data`.
- `setScreen(texture | null)`: screen parts show a live texture.

### Room record

```js
{
  id: "o…", part: "villa", label: "villa",
  p: [x, y, z], ry: 0, s: 1,
  color: "#rrggbb" | undefined, text: "…" | undefined,
  data: { … } | undefined,   // cards: { cards: ["AS", …], faceUp: false }, screens: { stream: "…" }, custom: { blueprint }
  attach: { user, hand: "left" | "right", grip: "snap" | "keep", rel: { p: [...], q: [x, y, z, w] } } | null,
  onto: "id" | undefined,    // placed on top of another record (moves with it when that is moved by voice)
  by: "u…", t: 1730000000000,
}
```

### Room ops (`js/core/room-state.js`, shared by browser and bridge)

```js
{ t: "add", obj: Record }
{ t: "set", id, patch: { p?, ry?, s?, color?, text?, data?, attach?, onto?, label? }, fly?: { vel: [x,y,z], spin } }
{ t: "del", ids: ["o…"] }
{ t: "clear" }
{ t: "env", time: "day" | "sunset" | "night" | "dawn" }
// every op may also carry: uid (unique op id), by (user id), transient (true = drag/hold
// streaming, not undoable, bridge does not persist to disk on every one)
```

`fly` is transient motion (a throw): every client animates the same ballistic arc; the thrower
then sends a normal `set` with the resting pose.

### Intents (output of the rule parser and of the model)

```js
{ do: "spawn", what: { part: "villa" } | { custom: Blueprint, label }, count?, place?, color?, scale?, text? }
{ do: "remove", target }        { do: "move", target, place }
{ do: "scale", target, factor } { do: "color", target, color }
{ do: "hold", target, hand }    { do: "drop", hand? }            // hand: "left" | "right"
{ do: "write", target?, text }  { do: "deal", target?, count }   { do: "shuffle", target? }  { do: "flip", target? }
{ do: "undo", count? }          { do: "clear" }                  { do: "time", value: "day"|"sunset"|"night"|"dawn" }
{ do: "say", text }             { do: "list" }

Target: { ref: "it" | "last" | "all" | "held" } | { part: "crate", which?: "nearest" | "last" | "all" | 2 } | { id }
Placement: {
  rel: "front" | "left" | "right" | "behind" | "here" | "feet" | "hand" | "on" | "next" | "above" | "far" | "at",
  hand?, dist? (meters), side? ("left" | "right" | "front" | "behind" for rel "next"),
  ref?: Target | { batch: n },   // n = index of an earlier spawn intent in the same command
  p?: [x, y, z]                  // rel "at"
}
```

### Blueprint (model-made or laptop parts bin JSON)

```js
{
  name: "dragon statue", aliases: [], desc: "…", holdable: false,
  parts: [ { shape: "box" | "sphere" | "cylinder" | "cone" | "capsule" | "torus",
             p: [x, y, z],   // center, meters, y up, ground at 0
             s: [x, y, z],   // bounding size of the primitive, meters
             r: [rx, ry, rz],// degrees, optional
             color: "#rrggbb" | named color,
             mat: "matte" | "wood" | "metal" | "glass" | "glow" | "stone" | "fabric" | "plastic" } ],
}
```

`normalizeBlueprint` clamps to 96 parts, sizes 0.01–60 m, re-centers so the bottom is y = 0,
and adds `size: [w, h, d]`.

### Player pose

```js
{ user: "u…", p: [x, y, z] /* head */, yaw, hands: { left: { p, q } | null, right: { p, q } | null } }
```

## Modules and owners

| File | Exports |
| --- | --- |
| `js/util/emitter.js` | `Emitter` (on/once/off/emit) |
| `js/util/ids.js` | `makeId(prefix)`, `randomString(n)`, `rng(seed)` |
| `js/util/text.js` | `drawText`, `textTexture`, `updateTextTexture`, `canvasTexture`, `makeCanvas` |
| `js/parts/build/kit.js` | `kit` (mat, box, cyl, sphere, cone, torus, capsule, plane, lathe, extrude, prism, group, textPanel, place, finish, measure, disposeObject) |
| `js/parts/meta/index.js` | `allMeta`, `getMeta`, `partNames`, `registerMeta`, `unregisterMeta`, `BUILTIN` |
| `js/parts/meta/*.js`, `js/parts/build/*.js` | `metas`, `builders` per category |
| `js/parts/build/blueprint.js` | `buildBlueprint(bp, opts)` → Object3D |
| `js/parts/build/index.js` | `buildObject(record)`, `registerBuilder(name, fn)`, `sizeOfRecord(record)` |
| `js/parts/remote.js` | `loadRemoteParts(net)` registers the laptop parts bin (blueprint/gltf/module) |
| `js/core/lexicon.js` | `normalizeText`, `singularize`, `matchPart`, `matchColor`, `COLORS`, `parseNumber` |
| `js/core/wake.js` | `stripWake(text, wakeWords)` → `{ matched, rest }` |
| `js/core/parse.js` | `parseCommand(text, { metas, wakeRequired, wakeWords })` → `{ intents, say, confidence, unknown, wake }` |
| `js/core/place.js` | `resolvePlacement(place, ctx)` → `{ p, ry, attach?, onto? }`, `forwardOf(yaw)`, `rightOf(yaw)`, `faceYaw(from, to)` |
| `js/core/execute.js` | `planIntents(intents, ctx)` → `{ ops, say, errors, undo }` |
| `js/core/room-state.js` | `createState`, `applyOp`, `invertOp`, `snapshot`, `loadState`, `validateOp`, `summarize` |
| `js/core/blueprint.js` | `normalizeBlueprint(bp)` → `{ ok, blueprint, error }`, `SHAPES`, `MATS` |
| `js/core/cards.js` | `newDeck()`, `shuffle(list, rng)`, `cardName(code)` |
| `js/world/field.js` | `Field` (ground, wind grass, sky, sun, hills, distant trees, time of day) |
| `js/world/phase.js` | `Phaser` (phaseIn/phaseOut/summon indicator) |
| `js/world/objects.js` | `SceneObjects` (room → meshes, attach, flight, wobble, picking, blob shadows) |
| `js/xr/xr.js`, `js/xr/hands.js` | `XR` session, controllers, locomotion; procedural controller models |
| `js/play/interact.js` | `Interact` (grab, hold, throw, weapon hits) |
| `js/play/desktop.js` | `DesktopControls` (mouse/keyboard), `TouchControls` (phone) |
| `js/voice/voice.js`, `wav.js`, `speak.js` | `Voice` (push-to-talk, wake word, hard mute), WAV encoder, `speak()` |
| `js/net/net.js`, `avatars.js`, `share.js` | `Net` (bridge client), `Avatars`, `Share` (screen/camera frames) |
| `js/ui/ui.js`, `js/ui/hud.js` | DOM UI (launch, desktop, phone companion), VR HUD |
| `js/room.js`, `js/runner.js`, `js/main.js` | room wrapper, command runner, bootstrap |
| `js/core/kingdom.js` | `ADVISORS`, `ADVISOR_WORDS`, `addressAdvisor(text)` → `{ advisor, rest }`, `kingdomQuery(text)` → topic, `kingdomStats(records)`, `kingdomReport(stats, topic)`, `kingdomAdvice(stats)`, `advisorAck`, `WORTH` (pure) |
| `js/world/kingdom.js` | `KingdomScene` (advisors, wandering villagers, village square, aim ring; local only) |
| `js/selftest.js` | `runSelfTest({ phase, report, … })`, `summarize(report)`, `postReport(net, report)`: the one-tap headset check (report saved by the bridge via `api/report`) |
| `bridge/doctor.mjs`, `bridge/eval-model.mjs`, `bridge/check-headset-report.mjs` | laptop acceptance CLIs used by the owner's check-only pipeline (exit 0 = pass) |
| `bridge/*.mjs` | laptop bridge |

## Kingdom mode

A per-device setting (`settings.kingdom`, URL `?mode=kingdom` / `?mode=training`). Nothing new is
synced: buildings are ordinary catalog parts (category `kingdom`), and the advisors, villagers,
square and aim ring are drawn locally by `KingdomScene`.

- **Advisors.** The runner strips the wake word, then an advisor title (`addressAdvisor`). The rest
  runs as a normal command; the reply is signed `"<Title>: <ack> <say>"` and the runner emits
  `advisor` `{ id }` so that advisor nods. Titles join the voice wake words while the mode is on.
- **Realm questions.** `kingdomQuery` recognizes questions about the realm before the parser runs;
  the reply is `kingdomReport(kingdomStats(records), topic)`. Stats come from `WORTH` per part.
- **Pointing.** In Kingdom mode the player pose carries `aim: [x, 0, z]`, the ground point under
  the right-hand ray (VR) or the view center (flat), within 120 m. `resolvePlacement` puts
  `rel: "here"` and `rel: "front"` with `point: true` (the parser's "over there") on the aim point,
  pushed out to the object's radius from the player and clear of ground records. Without `aim`,
  both keep their old meaning.
- **Behavior defaults.** A meta may name `behavior` (one of the behavior kinds); new records of that
  part get `data.behavior = { kind, speed: 1 }` (peasants walk).

## Bridge HTTP API

Base path: `/vr-games/games/training-room/api/` (alias `/api/`). The bridge serves the whole
repository under `/vr-games/` exactly like GitHub Pages (dot-folders and `bridge/` refused), and
redirects `/` to the game.

Auth: a room key printed by the bridge (10 characters; shorter keys in an older config.json still
work). `GET /?k=KEY` sets an HttpOnly cookie `tr_key`; API calls may instead send header
`x-room-key` or query `k`. `GET api/hello` is always open.

| Method & path | Body → response |
| --- | --- |
| `GET api/hello` | → `{ bridge: true, auth, version, model: { available, name, provider, vision /* vision model name or null */ }, stt: { available, kind }, tts: { available, kind }, parts: { count }, lan: [urls] }` |
| `POST api/join` | `{ name, device, color? }` → `{ user, users, state, seq }` |
| `GET api/events?user=ID` | SSE: `op` `{ seq, op }`, `state` `{ seq, state }` (full snapshot when missed ops cannot be replayed), `users` `[...]`, `poses` `{ id: pose }`, `fx` `{ user, fx }`, `share` `{ stream, user, active, n }`, `say` `{ user, text }`, `parts` `{ count }` (laptop parts bin changed) |
| `POST api/op` | `{ user, op }` → `{ seq }` (410 if user unknown → re-join) |
| `POST api/pose` | `{ user, pose }` → 204 (bridge rebroadcasts all poses at 15 Hz) |
| `POST api/fx` | `{ user, fx }` → 204 |
| `POST api/say` | `{ user, text }` → 204, broadcasts `say` |
| `POST api/command` | `{ user, text, ctx: { player, scene, parts } }` → `{ intents, say, source: "model", model, ms }`; 503 `{ error: "no-model" }` |
| `POST api/interpret` | `{ user?, image?, ascii, stats, size, hint?, parts? }` (≤ 600 KB) → `{ guess, confidence, part, blueprint?, behavior, say, source: "model", model, vision, ms }`; 503 `no-model`, 502 `bad-output`, 504 `timeout`, 400 `no-sketch`/`bad-image` (see "Magic marker") |
| `POST api/transcribe` | `audio/wav` body → `{ text, ms }`; 503 `{ error: "no-stt" }` |
| `POST api/tts` | `{ text }` (≤ 400 chars) → audio bytes (`audio/wav`, or the voice server's audio type); 503 `{ error: "no-tts" }` (off or unreachable), 504 `tts-timeout`, 502 `tts-failed` |
| `POST api/report` | `{ kind: "headset"\|"client", user?, report: { … } }` (≤ 128 KB) → `{ saved: "<kind>-<YYYYMMDD-HHMMSS>-<user or ip>.json" }`, written owner-only to `<data>/reports/` and never overwritten (`bridge/check-headset-report.mjs` reads the headset ones); 400 `bad-kind`/`bad-report`, 413 `too-large` |
| `GET api/parts` | → `{ parts: [ { name, aliases, category, desc, size, holdable, grip?, kind: "blueprint"\|"gltf"\|"module", url?, blueprint? } ] }` |
| `GET api/parts/file/<path>` | parts-bin file (glb, gltf, bin, png, jpg, js, mjs, json) |
| `POST api/parts/save` | `{ blueprint }` → `{ name }` (saved to `<parts>/generated/`) |
| `POST api/share/<stream>` | `image/jpeg` body → 204, broadcasts `share` |
| `GET api/share/<stream>` | latest JPEG |
| `POST api/share/<stream>/stop` | → 204, broadcasts `share` with `active: false` |
| `POST api/leave` | `{ user }` → 204 |

## Controls

VR (Quest, xr-standard mapping): left stick move (click = sprint), right stick snap turn
left/right and teleport forward, squeeze = grab/hold (release to drop or throw), trigger = point
and click HUD, **A or X held = push-to-talk**, **Y = mic hard mute on/off**, **B = menu**.

Desktop: click to look (pointer lock), WASD/arrows move, Shift sprint, **hold V = talk**,
**M = mute**, Enter = type a command, E = grab/drop, left click = swing held item, Z = undo.

Phone companion: big hold-to-talk button, mute switch, command box, parts chips, object list,
drag to look, follow-headset camera, share camera.

## Magic marker (sketch → AI guess → it comes alive)

Inspired by Harold and the Purple Crayon and ChalkZone. The player draws; the model guesses what
the drawing is and makes it real where it was drawn, then it comes alive. Misreads are part of
the fun ("that's clearly a fish"); "no, it's a gun" corrects it.

### Records and parts

- `marker` (catalog, office): holdable, `marker: true`, built upright with the nib on top,
  `grip.r = [-90, 0, 0]`, `tip` at the nib. While a hand holds a marker, its trigger draws.
- `drawing` (not in the catalog; special builder): `p` = frame origin (world, where the drawing
  started), `ry` = yaw the drawing faces (toward the person drawing).
  `data = { strokes: [ { c: "#9b6bff", w: 0.012, pts: [x, y, z, x, y, z, …] } ], by }` with points in
  drawing-local meters (x right, y up, z toward the drawer), rounded to 5 mm, ≤ 6000 points total.
- `doodle` (not in the catalog; special builder): the drawing made solid when nothing better is
  known. Same `data.strokes`; closed strokes become extruded colored cut-outs, open strokes thick tubes.
- Any record may carry `data.behavior = { kind, speed }` with kind one of
  `swim | fly | walk | hop | roll | spin | float | bounce | sway | none`. The 3D layer animates the
  inner object around the record pose every frame (deterministic from time + id, no network
  traffic) and skips it while the object is held.

### Intents

```js
{ do: "realize", target?, hint? }        // "AI, make it real", "bring it to life", "make it a fish" (hint)
{ do: "guess", target? }                 // "what is this?" → say only
{ do: "correct", label, target? }        // "no, it's a gun" → replace the last realized thing in place
                                         // (catalog part, else model-made, else a labelled crate)
{ do: "animate", target, behavior }      // "make it fly", "make the dog walk", "stop moving" (none)
{ do: "erase", target? }                 // "erase the drawing", "wipe it"
```

Default target for realize/guess/erase: the nearest `drawing` within 15 m, preferring the most
recent one by this user.

### Pure helpers (`js/core/sketch.js`)

`simplifyStroke(flatPts, epsilon)`, `quantize(flatPts, step)`, `sketchBounds(strokes)` →
`{ min, max, size, center }`, `projectStrokes(strokes)` → 2D polylines in the drawing plane,
`asciiArt(strokes2d, cols = 40, rows = 20)`, `sketchStats(strokes)` →
`{ strokes, points, closed, aspect, width, height }`, `classifySketch(strokes2d)` →
`{ guess, part, confidence, behavior }` (offline heuristic: circle → ball, box → crate,
triangle → tent, triangle over box → house, long line → staff, otherwise null),
`limitStrokes(strokes, maxPoints)`.

### Bridge

`POST api/interpret { image?: "data:image/png;base64,…", ascii, stats, size: [w, h], hint?, parts? }` →
`{ guess, confidence, part, blueprint?, behavior, say, source: "model", model, vision: bool, ms }`.
Uses a vision model when one is installed (Ollama `/api/show` capabilities include "vision", or
`config.visionModel`; Ollama messages carry `images: [base64]`, OpenAI-compatible servers get
`image_url` content parts). Otherwise the text model receives the ASCII rendering and stats.
503 `{ error: "no-model" }` when no model is reachable.

### Input

- VR: hold a marker (spawn with "AI, give me a marker" or the HUD menu "Marker"); trigger draws from
  the marker tip. Release ends the stroke. Strokes within 2 m of an open drawing (yours, < 60 s
  since its last stroke) join it.
- Desktop: **F** toggles marker mode (pointer lock released, a faint drawing sheet appears 2.5 m
  ahead); left-drag draws on it.
- Phone: **Draw** opens a full-screen sketch pad (finger drawing, colors, undo stroke, clear,
  "Send", "Make it real"); the sketch appears 2 m wide in front of the acting player (the headset
  player when one is connected).
- The live stroke is drawn locally every frame; the bridge receives one op per finished stroke.

## Additions after review

- Targets may carry `side: "left" | "right" | "front" | "behind"` ("remove the crate on my left").
- `write` with empty `text` wipes a board or note ("clear the whiteboard").
- Placement `next` honours `dist` (center to center, never overlapping); `above` may take a `ref`.
- Model placements like `{ rel: "right", ref }` are rewritten to `next` with that side.
- Drawing builders expose `userData.appendStrokes(data)` so a pen-up stroke is uploaded in place.
- `Share.prune(shownStreams)` frees ended streams no screen shows; `SceneObjects` calls it twice a second.
- `warmUp(renderer, scene, camera, extraMaterials)` in `world/phase.js` compiles first-use shaders
  at start (HUD, controllers, teleport arc, stars, marker ink).
- The bridge applies an op `uid` once (clients retry timed-out sends), refuses ids that name
  `Object.prototype` members, throttles wrong room keys before checking any key, answers plain HTTP
  only for localhost Host names, and stores its data folder owner-only (0700/0600).
