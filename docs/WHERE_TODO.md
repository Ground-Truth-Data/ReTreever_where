# /where rework — running checklist

Started 3 Sep 2026 from Chris's annotated screenshot (Monosnap `260903 08.34.png`).
This list is the source of truth for the job; tick items off here, never in chat.
Rules that bind it: Get Cache art stays in `rapper/gc` and is imported via `$gc`
(never copied into the child); every panel icon is white outline on the same
slanted grey slot art; git moves forward only.

## Target layout (from the mockup)

```
LEFT PANEL (5 slots, same button-panel.svg)     RIGHT SIDE
  1. people  → /where/orgs                         top-right: + / − zoom, same slot art
  2. tree    → /where/projects  (Get Cache white     (mirrored, 2 slots)
                tree, $gc/assets/tree_white.webp)
  3. folder  → favourites                          bottom-right: dog (Around Me),
  4. polygon → draw tool                             round button like the reset one
  5. map     → map style (natural/streets/satellite)
Gone: line tool, trash, the Mapbox top-left +/−/pitch/style stack.
```

## ⛓️ CONSTRAINTS

- Get Cache assets live in `rapper/gc`; the child imports `$gc/...` and declares it in `deps.json`.
- One WherePage instance across `/where`, `/where/orgs`, `/where/projects` — toggling a view must never reload the globe.
- Icons: white, outline, same weight; same slot art for every button, left and right.
- The child owns no storage and no host names (`noParentNames.test.ts`).

## Done

- [x] Durable checklist (this file) — indexed by `docs/README.md` via `node tools/docsIndex.mjs`.
- [x] Left panel reordered: people, tree, folder, polygon, map. Line + trash removed.
- [x] People icon (`whereAssets/tool-people.svg`, three-person group lifted from `map-marker-osem-people.svg`).
- [x] Tree = Get Cache white tree, `$gc/assets/tree_white.webp` (from `treeFontWhite.webp`), declared in `deps.json`.
- [x] Map icon (`whereAssets/tool-map.svg`) cycles the basemap through `defaultStyleOptions` (natural → streets → satellite).
- [x] Mapbox top-left controls no longer added (`showNavigation:false`, `showStyleControl:false`); scale bar kept via new `showScale` option in `mapInit`.
- [x] Zoom + / − on the right in the same slot style (`whereAssets/zoom-panel.svg`, mirrored two-slot cut of `button-panel.svg`).
- [x] Dog (Around Me) moved to the bottom-right as a round button.
- [x] Polygon slot is the draw tool (`pickDrawTool("polygon")`).
- [x] URL view segment: `/where/orgs`, `/where/projects` via `[view=whereView]` matcher; WherePage lives in `routes/where/+layout.svelte` so the map survives the toggle. Registry `paths`/`views`, `hooks.ts` SERVED, ReTreever + rapper mirrors, `childRegistry.test.ts` allow-list.
- [x] Feature-select deep link (`?land=`) keeps the current view segment instead of bouncing to bare `/where`.

## Still to do

- [ ] **What orgs / projects actually change on the map.** Today the segment only lights the button. Decide: filter the polygon/marker layer by `organizationKey` vs `projectKey`? Different marker art? Different marker box? (Chris to say.)
- [ ] **Snake ruler as the polygon draw tool.** `getCache_OfflineMap/lib/mapUi/SnakeRuler.svelte` is self-contained but needs `ports: MapHostPorts`, `@turf/turf`, `../shared/rendererOf`, `../shared/mapKeepOut`, `../panels/measureFormat`. Importing it into the where child means: declaring `$parent/siblings/getCache_OfflineMap/lib/mapUi/SnakeRuler.svelte` in `deps.json` (a child importing a sibling child — check `childBoundary.test.ts` allows it; who_what↔OnlineMap is the precedent), supplying a minimal `MapHostPorts` fixture from the host, and deciding whether it *replaces* `MapDrawControls` (polygon persistence via `onFeatureComplete`) or sits beside it.
- [ ] **Clearing drawings.** Trash is gone, so `onFeaturesCleared` is wired but unreachable from the UI. Options: long-press on the polygon slot, a "clear" inside the draw popover, or accept that drawings persist until cleared elsewhere.
- [ ] **Launch gate.** `LAUNCH_BLOCK_EXACT` in `ReTreever/src/lib/core/launchGate.ts` matches `/where` exactly; `/where/orgs` and `/where/projects` would slip past if `TEMP_GETCACHE_LAUNCH` is ever flipped back on. Add them (or switch the gate to prefix) when that happens.
- [ ] **Style switch and drawn shapes.** `map.setStyle` drops custom sources; check `MapDrawControls` re-adds its draw layers after a basemap swap (the old dropdown had the same exposure, so not a regression — just untested).
- [ ] **Mobile breakpoint pass.** Right-side zoom panel and the dog button have first-guess `@media (max-width: 767px)` positions; check on a phone width.
- [ ] Hover tooltips for the right-side buttons mirror left (they open to the left).
- [ ] `hitch_test.sh` and `packTest.sh` run green for `ReTreever_where` after the `deps.json` additions.
- [ ] Ship: child pushed (`gitEr/publishChildren.sh`), registry change in rapper, ReTreever + OnlineMap committed.

## Decisions taken without asking (redirect if wrong)

- Dog goes **bottom-right** — Chris's words said "left side" but the mockup shows it right; the mockup won.
- Map icon **cycles** styles on click (no dropdown); tooltip names the next style.
- Toggling the active people/tree button again returns to bare `/where`.
- Deep-link query (`?land=`) and the map hash are carried across the view toggle.
