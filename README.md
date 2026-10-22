# DOT / GAMES

A public, independent home for browser VR games. This repository is separate from Sophia's app and has no connection to its code or deployment.

- **Site:** https://dot0m0peg-arch.github.io/vr-games/
- **Miner:** https://dot0m0peg-arch.github.io/vr-games/games/miner/
- **The Neighborhood:** https://dot0m0peg-arch.github.io/vr-games/games/neighborhood/
- **Training Room:** https://dot0m0peg-arch.github.io/vr-games/games/training-room/
- **Repository:** https://github.com/dot0m0peg-arch/vr-games

The shell is live with three early-access games. Miner plays in any browser; its VR mode is new and not yet tested on a headset. The Neighborhood and Training Room also play in the browser, and their headset passes are not verified yet either. The geometric decorations belong to the portal, not the games. The portal has no trackers, external runtime dependencies, accounts, or backend services; Training Room's optional laptop bridge runs on the owner's own laptop (see Hosting boundary).

## Layout

```text
index.html                 Games landing page; add new listings here
how-to-play.html           Player instructions and VR capability check
assets/                    Shared styles, favicon, VR check
 games/
  miner/index.html         Miner (browser + experimental VR mode)
  miner/assets/            Miner's own assets
  neighborhood/            The Neighborhood: built output of the owner's Neighborhood project (see its README.md)
  training-room/           Training Room: voice-summoning sandbox; optional laptop bridge in bridge/ (see its README.md)
  _template/               Copy for each additional game
 docs/
  ADDING-GAMES.md           Claude's game integration guide
  DEPLOYMENT.md             Publishing and recovery steps
CLAUDE.md                  Short handoff for Claude
 tools/check_site.py       Dependency-free site integrity check
```

## Publish

GitHub Pages publishes **main → / (root)**. Commit and push the finished static files to main; GitHub builds and deploys automatically. `.nojekyll` preserves ordinary static files, including folders beginning with underscores. No npm install or build is required for the portal.

See [adding games](docs/ADDING-GAMES.md) and [deployment](docs/DEPLOYMENT.md). For a local preview, run `python -m http.server 8000` from the repository and open http://localhost:8000. Stop it with Ctrl+C. WebXR on a headset requires the published HTTPS URL; a plain HTTP LAN address is insufficient.

To check links and required site files, run `python tools/check_site.py`. Follow the owner's laptop pipeline rules when working on that machine.

## Hosting boundary

GitHub Pages serves static HTML, CSS, JavaScript, WebAssembly and assets. Games must be browser/WebXR builds, not APKs or desktop executables. The site needs no VR store developer account to distribute a browser game. A game needing a server needs a separately configured service; do not put API keys or secrets in this public repository. Training Room's optional bridge is such a service: the owner runs it on their own laptop, and it stores its keys and room data outside the repository.

GitHub Pages does not offer arbitrary HTTP response headers. Builds requiring cross-origin isolation, special compression headers or a backend may need a different host or export settings. See the integration guide before uploading Unity/WebGL or threaded WASM output.

No license for the owner's existing games or art is implied by this new public hosting shell.
