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
| `bridge/*.mjs` | laptop bridge |

## Bridge HTTP API

Base path: `/vr-games/games/training-room/api/` (alias `/api/`). The bridge serves the whole
repository under `/vr-games/` exactly like GitHub Pages (dot-folders and `bridge/` refused), and
redirects `/` to the game.

Auth: a short room key printed by the bridge. `GET /?k=KEY` sets an HttpOnly cookie `tr_key`;
API calls may instead send header `x-room-key` or query `k`. `GET api/hello` is always open.

| Method & path | Body → response |
| --- | --- |
| `GET api/hello` | → `{ bridge: true, auth, version, model: { available, name, provider }, stt: { available, kind }, parts: { count }, lan: [urls] }` |
| `POST api/join` | `{ name, device, color? }` → `{ user, users, state, seq }` |
| `GET api/events?user=ID` | SSE: `op` `{ seq, op }`, `users` `[...]`, `poses` `{ id: pose }`, `fx` `{ user, fx }`, `share` `{ stream, user, active, n }`, `say` `{ user, text }` |
| `POST api/op` | `{ user, op }` → `{ seq }` (410 if user unknown → re-join) |
| `POST api/pose` | `{ user, pose }` → 204 (bridge rebroadcasts all poses at 15 Hz) |
| `POST api/fx` | `{ user, fx }` → 204 |
| `POST api/command` | `{ user, text, ctx: { player, scene, parts } }` → `{ intents, say, source: "model", model, ms }`; 503 `{ error: "no-model" }` |
| `POST api/transcribe` | `audio/wav` body → `{ text, ms }`; 503 `{ error: "no-stt" }` |
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
