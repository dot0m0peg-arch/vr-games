# Claude handoff: DOT / GAMES

Owner-authorized new public VR game portal, independent of Sophia's app.

- Repository: https://github.com/dot0m0peg-arch/vr-games
- Public shell: https://dot0m0peg-arch.github.io/vr-games/
- Miner entry: https://dot0m0peg-arch.github.io/vr-games/games/miner/
- Static HTML/CSS/JS, no framework or install step. Pages deploys main / root; preserve `.nojekyll`.
- Read `README.md`, `docs/ADDING-GAMES.md`, `docs/DEPLOYMENT.md` and existing owner instructions before changing files.
- Both games are imported builds, not placeholders. Miner (`games/miner/`) is the owner's single-file Three.js game, copied from the owner's Miner project. The Neighborhood (`games/neighborhood/`) is a Babylon.js export; do not hand-edit it (see its README). VR mode is not yet verified on a headset for either game. Make game fixes in the source project and re-copy the build; a fix made only here is undone by the next export. Next action: verify both games on a headset, then update their status text in `index.html` to what was tested.
- Use one folder per game. Keep asset URLs relative to that folder and respect the `/vr-games/` project prefix. Test direct/deep URLs.
- Preserve the portal design, owner art and other projects. Do not use Sophia's repository, deployment, settings or source.
- Validate links with `python tools/check_site.py`; verify deployed pages and actual headset behavior separately. Follow the owner's laptop check-only pipeline when applicable.
- Publication is authorized for this portal; do not infer authorization for spending, store accounts, unrelated projects or game asset replacement.
- Handoffs for the owner's pipeline go to the private PROJECT-COMMAND repository on a `claude/<topic>-<date>` branch. A session started on vr-games cannot grant itself write access to another repository; the permission layer refuses the attempt, so do not retry it. Start the session with both repositories selected, or create a child session on PROJECT-COMMAND (`create_session` with its URL and an `outcome_branch`) and have it commit the handoff.
