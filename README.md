# ReTreever_where

The Where map page of ReTreever.

This is a **child**: a folder a host builds, never an app of its own. A host
mounts it by resolving the `$parent` alias to itself, so one import line lands
in whichever tier is running — and a child cloned alone defines no `$parent`,
so a stray import fails loudly at build instead of rendering half a page.

Serves `/where`. Mounted alone, `/` reroutes to it.

## It needs a sibling

Unlike the other children, this one is **not self-contained**. It takes the
online map from `getCache_OnlineMap` sitting beside it:

- `$parent/siblings/getCache_OnlineMap/lib/MAP_CONFIG`
- `$parent/siblings/getCache_OnlineMap/lib/mapDrawControls.svelte`

Clone this repo on its own and those imports resolve to nothing. The alias is
what lets the same line work from either tier; a raw `../getCache_OnlineMap/…`
names a parent and the guards reject it.

## The host contract

Props, typed in [`lib/whereTypes.ts`](./lib/whereTypes.ts):

- `WhereRoutes` — where the marker box can send you. Every entry is optional,
  because a child running on rapper has nowhere to go; those links just don't
  render.
- `FavouriteLocation` — a starred spot, carrying its own coords so the map can
  fly back without refetching centroids.

[`deps.json`](./deps.json) is the entire allow-list, and `lib/` is the one door
to the host.

## The NaN boundary

Three modules exist for one reason: a NaN or out-of-range value reaching
Mapbox's projection math corrupts the camera permanently, and every later call
crashes deep in `_calcMatrices` with an unhelpful stack.

All three live in `getCache_OnlineMap/lib/` and are imported from there, the
same way this child already takes `mapInit`, `mapConfig` and `mapDrawControls`:

- `coord.ts` — `Coord`, a branded `[lng, lat]` tuple you can only build
  through the validators. Values are checked at the boundary, not at use.
- `safeMap.ts` — the only sanctioned way to move the camera. `flyTo`,
  `fitBounds`, `easeTo`, `jumpTo`, `panTo`, `setCenter`, `setZoom`,
  `setBearing` and `setPitch` all go through these wrappers; direct calls are
  banned and checked for.
- `safeEase.ts` — works around mapbox-gl 3.x globe projection recursion
  (`setLocationAtPoint` → set center → `_updateZoomFromElevation`), which blows
  the stack on animated `easeTo`/`flyTo`. Interpolates via rAF + `jumpTo` on
  globe, falls back to `easeTo` on mercator.

⚠️ They must NOT be copied back into this child. `safeEase` cancels a previous
animation through a module-level `WeakMap<Map, number>`, and `initializeMap`
(getCache_OnlineMap) attaches a `zoomend` handler that eases the same map
through its own copy. A second copy here means two registries over one map:
neither can cancel the other's rAF loop, and both write `jumpTo` on alternating
frames. That is what a local fork of these files caused before.

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
