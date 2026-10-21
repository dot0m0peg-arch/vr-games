# Claude handoff: DOT / GAMES

Owner-authorized new public VR game portal, independent of Sophia's app.

- Repository: https://github.com/dot0m0peg-arch/vr-games
- Public shell: https://dot0m0peg-arch.github.io/vr-games/
- Miner entry: https://dot0m0peg-arch.github.io/vr-games/games/miner/
- Static HTML/CSS/JS, no framework or install step. Pages deploys main / root; preserve `.nojekyll`.
- Read `README.md`, `docs/ADDING-GAMES.md`, `docs/DEPLOYMENT.md` and existing owner instructions before changing files.
- Miner is a truthful **coming soon** placeholder. The actual game has not been imported or implemented. Next action: obtain the actual Miner WebXR build and integrate it into `games/miner/`, preserving owner art and game behavior.
- Use one folder per game. Keep asset URLs relative to that folder and respect the `/vr-games/` project prefix. Test direct/deep URLs.
- Preserve the portal design, owner art and other projects. Do not use Sophia's repository, deployment, settings or source.
- Validate links with `python tools/check_site.py`; verify deployed pages and actual headset behavior separately. Follow the owner's laptop check-only pipeline when applicable.
- Publication is authorized for this portal; do not infer authorization for spending, store accounts, unrelated projects or game asset replacement.
