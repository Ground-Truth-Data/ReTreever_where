# ReTreever_where

The Where map page of ReTreever.

This is a **child**: a folder a host builds, never an app of its own. A host
mounts it by resolving the `$parent` alias to itself, so one import line lands
in whichever tier is running — and a child cloned alone defines no `$parent`,
so a stray import fails loudly at build instead of rendering half a page.

Serves `/where`. Mounted alone, `/` reroutes to it.

## Self-contained

This child owns its own Mapbox map (`lib/mapInit.ts`, `lib/MAP_CONFIG.ts`,
`lib/mapDraw.ts`, `lib/WhereDrawControls.svelte`). It imports nothing from
`getCache_OnlineMap` or any other child; the only aliases it reaches are
`$parent` (its host) and the shared tree `$gc` / `$rig` / `$rt`.

## The host contract

Props, typed in [`lib/whereTypes.ts`](./lib/whereTypes.ts):

- `WhereRoutes` — where the marker box can send you. Every entry is optional,
  because a child running on rapper has nowhere to go; those links just don't
  render.
- `FavouriteLocation` — a starred spot, carrying its own coords so the map can
  fly back without refetching centroids.

`lib/` is the one door to the host.

## The NaN boundary

Three modules exist for one reason: a NaN or out-of-range value reaching
Mapbox's projection math corrupts the camera permanently, and every later call
crashes deep in `_calcMatrices` with an unhelpful stack.

- `lib/coord.ts` — `Coord`, a branded `[lng, lat]` tuple you can only build
  through the validators. Values are checked at the boundary, not at use.
- `lib/safeMap.ts` — the only sanctioned way to move the camera. `flyTo`,
  `fitBounds`, `easeTo`, `jumpTo`, `panTo`, `setCenter`, `setZoom`,
  `setBearing` and `setPitch` all go through these wrappers; direct calls are
  banned and checked for.
- `lib/safeEase.ts` — works around mapbox-gl 3.x globe projection recursion
  (`setLocationAtPoint` → set center → `_updateZoomFromElevation`), which blows
  the stack on animated `easeTo`/`flyTo`. Interpolates via rAF + `jumpTo` on
  globe, falls back to `easeTo` on mercator.

⚠️ One copy per map. `safeEase` cancels a previous animation through a
module-level `WeakMap<Map, number>`, and `initializeMap` attaches a `zoomend`
handler that eases the same map through it. A second copy over one map means
two registries: neither can cancel the other's rAF loop, and both write
`jumpTo` on alternating frames.

## Tests

```sh
npm test
```

Vitest, and it runs in a bare clone with no app around it. `noParentNames`
is the portable half of the escape guard — a child ships no `vite.config.ts`,
so it has no build to hook a plugin into; the parents enforce the same rule as
an unskippable Vite plugin.

## Licence

AGPL-3.0 — see [`LICENSE`](./LICENSE).
