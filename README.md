## stardew valley web port
pls report issues here. give credits if you add to your site. play at [degloved.net](https://degloved.net/games/public/gms/stardew-valley/index.html)

one day ill re-port this and make it open source

### hosting notes

The site is served by GitHub Pages, so **`.nojekyll` must stay in the repo root** — without it Jekyll drops `_framework/` and the game runtime 404s.

The game archives (`Content.tar*`, `ContentAudio.tar*`) are far too large for a Pages deploy (~600 MB makes the Pages file sync time out and get cancelled). They live on the `game-assets` branch and are fetched from `raw.githubusercontent.com`. To download them again: `git fetch origin game-assets && git checkout game-assets -- .` — or open the page with `?assets=local` to load them relative to the page.
