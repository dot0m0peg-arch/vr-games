Training Room laptop parts bin
==============================

Drop files into this folder (or add folders to "partsDirs" in config.json). The bridge rescans
every few seconds; reload the game to pick up new parts. Spoken names are the file names
(lowercase, "-" and "_" become spaces) unless the file says otherwise.

1. Blueprints: <name>.json
   { "name": "dragon statue", "aliases": ["dragon"], "desc": "stone dragon on a plinth",
     "holdable": false,
     "parts": [ { "shape": "box", "p": [0, 0.25, 0], "s": [1.2, 0.5, 1.2], "r": [0, 0, 0],
                  "color": "#777777", "mat": "stone" }, ... ] }
   shape: box | sphere | cylinder | cone | capsule | torus
   p: center in meters (y up, ground at 0), s: bounding size in meters, r: rotation in degrees
   mat: matte | wood | metal | glass | glow | stone | fabric | plastic
   Designs the AI makes are saved to the generated/ subfolder in this format.

2. Models: <name>.glb or <name>.gltf (+ its .bin and textures next to it)
   Optional sidecar <name>.part.json:
   { "aliases": ["my sword"], "size": [0.2, 1.1, 0.05], "holdable": true,
     "grip": { "p": [0, 0.2, 0], "r": [-90, 0, 0] }, "category": "combat", "desc": "my sword" }
   Model origin should be bottom-center, front facing +Z, units in meters.

3. Code parts: <name>.js or <name>.mjs exporting
   export default { name, aliases, size, holdable, desc, build(THREE, opts) { return object3D; } }
   These run as code in the game's browser tab, so only put your own trusted code here.
   The bridge reads metadata from an optional <name>.part.json sidecar.
   Files whose names start with "_" (shared helpers, textures) are served but not listed as parts.
