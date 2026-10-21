# Deploying DOT / GAMES

## Current configuration

- Owner/repository: `dot0m0peg-arch/vr-games` (public).
- Branch: `main`; Pages source: **Deploy from a branch**, **main**, **/ (root)**.
- Site: https://dot0m0peg-arch.github.io/vr-games/
- Miner: https://dot0m0peg-arch.github.io/vr-games/games/miner/
- Keep `.nojekyll` at the root. No custom Actions workflow is needed.
- HTTPS is the WebXR entry point. No custom domain or paid plan is required for this setup.

## Update the site

1. Clone this repository, or open the existing checkout. Read `CLAUDE.md`.
2. Add the exported game to its own `games/<slug>/` folder. Keep each game's assets beside it.
3. Check all relative paths, start/exit behavior, loading errors and actual controls. Use `python tools/check_site.py` for site link checks; test the actual game in a compatible headset separately.
4. Commit the intended files and push to `main`. Through GitHub's web editor, commit the changes to main instead.
5. Check the repository's Actions tab for **pages build and deployment** and wait for its success. A push is not proof of deployment.
6. Open the public URL and the game's direct URL, reload, and confirm the new content. If content is cached, try a fresh tab or a cache-busting query string.

For owner-laptop work, submit code/checks through the existing check-only pipeline. The laptop pipeline is separate from GitHub Pages deployment; neither implies the other passed.

## Initial setup or recovery

In repository Settings → Pages, set Source to **Deploy from a branch**, then Branch **main**, folder **/ (root)** and Save. Ensure the repo is public and `index.html` exists at root. Confirm HTTPS is enforced once GitHub provisions the certificate.

If the site returns 404, first check Pages source and the deployment result. Paths and asset names are case sensitive. This is a project site: `/assets/foo` points outside this repository; use `./assets/foo` or an explicitly `/vr-games/`-prefixed path. Do not add an SPA redirect hack unless the particular game requires one.

To undo a broken release, revert its commit and push the revert to main. Preserve the broken commit for diagnosis; do not force-push or delete owner assets.

## Limits to check for each game

Consult the current [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits). Do not rely on Git LFS for runtime assets: Git LFS cannot be used with GitHub Pages. Keep binaries and bundles within GitHub's file/repository and Pages limits; optimize assets or choose a suitable game host if needed.

Official [Pages source configuration](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).
