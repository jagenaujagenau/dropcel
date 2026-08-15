# Dropcel — marketing site

The public site for Dropcel: an Astro page whose centrepiece is a low-fidelity
emulation of the app itself, driven entirely by the scrollbar.

```bash
cd site
pnpm install --ignore-workspace   # standalone; the root package is the Tauri app
pnpm dev                          # http://localhost:4321
pnpm build                        # → site/dist
```

## How the scene works

`src/components/AppWindow.astro` is the whole Dropcel window redrawn in HTML —
same tokens, same radii, same materials as `src/index.css` in the app, at about
a third of the detail. It is not a screenshot: a screenshot goes stale the week
after it is taken, and it cannot be driven by scroll position.

Every act is in the markup at once. The driver at the bottom of
`src/pages/index.astro` turns scroll position into an act index plus a 0–1
progress within that act, and everything else follows from `data-act` on the
window:

| # | act | what the window shows |
|---|-----|-----------------------|
| 0 | `empty` | `~/Vercel` with nothing in it |
| 1 | `drop` | a named folder carried in over the Matrix rain, released, landed |
| 2 | `detect` | one project, framework detected, not deployed yet |
| 3 | `build` | the card as a terminal, log typing out with the scroll |
| 4 | `live` | glass card with its URL, and the clipboard toast |
| 5 | `save` | an editor beside the card; the save is the deploy |
| 6 | `held` | offline — changes held rather than shipped or lost |
| 7 | `palette` | ⌘K over the full folder |
| 8 | `grid` | eight folders, eight live sites, menu bar watching |

Acts are not equal lengths. Each carries a `hold` weight in that same array —
how much scroll it is worth relative to the others — and the stage's height is
their sum. Acts that are a single still frame get 1; acts that are *doing*
something get more, the drop most of all at 3. The driver converts scroll
position into weight units and finds the act containing them.

## The drop overlay

This is the one act that is a gesture rather than a state, so it is the one act
the scrollbar performs rather than merely advances. The folder's position is a
function of progress through the act — it does not run on a timer — in three
beats: carried in from past the bottom-right corner (0–0.55), held over the
target (0.55–0.72), then released, shrinking into the window while the copy
switches to "Deploying…" (0.72–1). The rain's glow point travels with
the folder, so the triangle brightens as it arrives; the app feeds that same
uniform from the real drag position.

The effect itself is the app's, not an impression of it.
`src/lib/triangle-glow-shader.ts` and `src/lib/matrix-glyphs.ts` are copied
verbatim from `src/components/` in the app — if those change there, re-copy
them. `src/lib/triangle-glow.ts` is the React component ported to a plain mount
function, since this page ships no framework runtime. It differs from the app in
three places, each commented where it happens:

- the failure envelope is gone (nothing here can be refused, so `u_error` is 0);
- the theme comes from `prefers-color-scheme` rather than the canvas's computed
  `color` — the page has no manual theme override, and the colour probe is
  actually wrong against `oklch()` tokens;
- the triangle is drawn at `0.38` of the canvas rather than `0.29`, because what
  makes the silhouette legible is how many glyph columns it spans, and this
  canvas is less than half the width of the app's window.

The WebGL2 context is created the first time the act comes on screen, never on
page load, and the render loop parks whenever the act is off screen. If WebGL2
is unavailable the overlay keeps its backdrop and copy and simply has no rain —
same fallback the app takes.

## Adding an act

Two edits that have to stay in step: the `acts` array in `index.astro` (the
caption, plus its `hold`) and the `ACTS` array in the driver (the `data-act`
name). The stage's scroll height follows from the weights on its own.

## Assets

Both are generated, not hand-made — regenerate them rather than editing the PNGs:

```bash
pnpm icons   # every favicon / touch icon / logo, from ../assets/icon.png
pnpm og      # public/og.png, the 1200x630 social card
```

`pnpm og` renders `tools/og/card.html` in a real browser so the card uses the
same webfont and gradients as the hero — **rerun it whenever the hero copy
changes**, or the social card will quietly show the old headline. Both scripts
need Chrome installed; `pnpm icons` also needs macOS (`sips`).

## Deploying

The site is a subdirectory of the app repo, so a Vercel project pointed at this
repo needs its **Root Directory** set to `site`. Everything else is detected.
