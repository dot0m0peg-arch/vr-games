# More things for the parts bin, from any chat

Training Room already knows thousands of things (the library in `js/parts/library/`), and the
laptop's own model designs anything missing on the spot. To add a big batch by hand, any free
chat thread (ChatGPT, Claude, a local model) can write them:

1. Paste the prompt below into a new chat, with your list or theme at the end ("50 zombie
   survival items", "everything in a pirate ship", or a list of names).
2. Save the answer as a `.json` file (for example `zombie-stuff.json`) in the laptop parts
   folder: `%APPDATA%\dot-training-room\parts` (the bridge's `Parts:` line shows it).
3. Reload the game. Every thing in the file is in the parts bin, by name. Say "spawn a ..." or
   pick it from the menu. Ask the chat for the next batch and save it as another file.

Bad entries are skipped and named in the bridge window; the rest still load. Names that the game
already knows are skipped too (the game keeps its own).

## The prompt

```text
You write 3D props for a VR game as JSON, built only from simple shapes. Reply with one JSON
object and nothing else:

{ "category": "<a short theme name>", "parts": [ <THING>, <THING>, ... ] }

THING = { "name": "<lowercase, what people call it>", "aliases": ["<other names>"],
          "desc": "<a few words>", "holdable": true|false,
          "parts": [ SHAPE, SHAPE, ... ] }        (3 to 40 shapes; 8 to 25 is typical)

SHAPE = { "shape": "box"|"sphere"|"cylinder"|"cone"|"capsule"|"torus",
          "p": [x, y, z], "s": [width, height, depth], "r": [rx, ry, rz],
          "color": "#rrggbb", "mat": "matte"|"wood"|"metal"|"glass"|"glow"|"stone"|"fabric"|"plastic" }

Rules:
- Meters and real sizes. y is up, the thing stands on y = 0, its front faces +z.
- p is the center of the shape, s its bounding size, r an optional rotation in degrees.
- cylinder, cone and capsule stand along y (a cone's tip points up). A wheel lying on its side:
  r [90,0,0] (axle along z) or r [0,0,90] (axle along x). torus lies flat like a donut on a
  table (s[1] is the tube thickness); r [90,0,0] stands it up facing the front.
- Shapes touch or overlap; nothing floats. Use the real thing's colors; "glow" for lights,
  screens and fire, "glass" for windows.
- holdable: true for things one hand can hold (up to about 1.5 m). Things held by a handle
  (swords, axes, hammers, torches, bottles) stand upright with the handle at the bottom. Things you
  aim (guns, flashlights, cameras, hoses, drills) lie along z: front toward +z, handle under the
  back end. Blades and hammer faces point toward +x.
- Make each thing recognizable at a glance: the right silhouette first, then its 2-4 telltale
  details. Different things, not color variants.
- It is a family game: no gore, no real brands.

Make these:
<your list or theme here>
```

## Into the library (for the repository)

Batches good enough for everyone can move into `js/parts/library/<category>.json` (same format;
the file name must be listed in `LIBRARY_FILES` in `js/parts/library/index.js`). The tests
(`node --test tests/library.test.mjs`) check every entry the way the game loads it.
