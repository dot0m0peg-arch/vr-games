# Last Car Upright (browser build)

The owner's toy-car flip battle: a Vite build of https://github.com/dot0m0peg-arch/last-car-upright (Rapier physics in a
worker, three.js arena), with its icons, web app manifest and a service worker for offline play. It is written by that
project's `npm run build:site -- --site <this checkout>`; update it by running that again. Make code fixes in the source
project first, or the next copy undoes them.

Public entry: https://dot0m0peg-arch.github.io/vr-games/games/last-car-upright/

Plays in any desktop or phone browser with WebGL; without WebGL the collisions still resolve and are described in text.
No VR mode. Follow [the game integration guide](../../docs/ADDING-GAMES.md) and update the root collection status only
to what was tested.
