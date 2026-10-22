# Add or replace a WebXR game

## Update an existing game

Miner (`games/miner/`) and The Neighborhood (`games/neighborhood/`) are imported builds of the owner's projects. To update one, build it in its project and copy the new build over its folder here. Do not hand-edit the Neighborhood export (see its README). Preserve the owner's art and behavior. Do not replace a game with an invented one. Training Room (`games/training-room/`) is the exception: its source lives here, so edit it in place and run its tests.

After a headset pass, update the game's status line in root `index.html` to what was tested. Only claim controls, supported devices and features that were tested. Keep a route back to the collection in the game or its surrounding launch page.

## Another game

1. Copy `games/_template/` to `games/<lowercase-hyphenated-slug>/`.
2. Replace its placeholder and title/description with the actual static game export. Put its assets inside that folder. Do not edit other games' assets.
3. Add an `<article class="game-row">` listing to root `index.html`, using the existing Miner row as a markup example. Link to `games/<slug>/`. Update the collection count. Use the game's authorized art only; the portal SVG is decoration, not a game screenshot.
4. Test, commit and publish using [DEPLOYMENT.md](DEPLOYMENT.md).

## Paths and exports

- Use `./assets/model.glb` from the game's entry, not `/assets/model.glb`. Asset paths in JavaScript modules resolve relative to the module; use `new URL('./model.glb', import.meta.url)` where appropriate.
- For Vite exports set `base: './'` (or the exact `/vr-games/games/<slug>/` prefix), then copy the **built dist contents**, not the development server, into the game folder.
- Load modules with `<script type="module">`; use a real bundler or pinned, tested dependencies for bare imports. Keep imports and remote assets on HTTPS and ensure any cross-origin assets permit CORS.
- Browser builds may use WASM, but threaded WASM needs cross-origin isolation. GitHub Pages cannot set arbitrary COOP/COEP response headers. Prefer a compatible single-thread build or choose hosting with the necessary headers. Do not promise a threaded export will work here.
- Unity/WebGL exports must have compatible decompression fallback or uncompressed assets; Pages cannot set arbitrary Content-Encoding headers. Verify large files and headset memory use before declaring success.
- Do not commit private credentials, original private source unrelated to the game, or build caches. This repository and every published file are public.

## WebXR launch contract

- Render an ordinary loading/error/fallback screen before starting VR. Explain when a headset is required.
- Feature-detect `navigator.xr`, then await `navigator.xr.isSessionSupported('immersive-vr')`; handle rejection. The portal's `assets/xr-check.js` is an example of capability detection only, not a game engine.
- Start `navigator.xr.requestSession('immersive-vr', ...)` from the player's explicit Enter VR action. Request only the reference spaces/features the game uses and handle permission denial.
- Use the engine's XR rendering/controller integration; end the session cleanly, pause background work and audio appropriately, and restore an accessible launch screen when the session ends.
- Open games as top-level pages. If a later embed is necessary, test its WebXR permissions policy; do not assume an iframe can launch VR.
- Explain actual controller/desktop controls and comfort options. Provide an exit, restart and load-failure path appropriate to the game.

## Acceptance before marking playable

Open the deployed direct game URL in the target headset. Verify assets load, Enter VR, both controllers/inputs, intended core loop, exit/re-enter, and a reload. Test desktop fallback if offered. Check the collection links and a phone-width page. Record device/browser and failures honestly. A site link check or desktop preview is not headset acceptance.

References: [WebXR](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API), [session startup](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API/Startup_and_shutdown), [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).
