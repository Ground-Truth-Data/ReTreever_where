# /where rework — what's left

A done line is DELETED, never ticked. When the file is empty, delete it.

## ⛓️ CONSTRAINTS

- Get Cache assets live in `rapper/gc`; the child imports `$gc/...` and declares it in `deps.json`.
- One WherePage instance across `/where`, `/where/orgs`, `/where/projects` — toggling a view must never reload the globe.
- Icons: white, outline, same weight; same slot art for every button, left and right.
- The child owns no storage and no host names (`noParentNames.test.ts`).

## Still to do

- [ ] **What orgs / projects actually change on the map.** Today the segment only lights the button. Filter the layer by `organizationKey` vs `projectKey`, or different marker art? (Chris to say.)
- [ ] **Clearing drawings.** Trash is gone, so `onFeaturesCleared` is wired but unreachable from the UI — long-press on the polygon slot, or a "clear" inside the draw popover.
- [ ] **Snake ruler as the polygon draw tool.** `getCache_OfflineMap/lib/mapUi/SnakeRuler.svelte` needs `ports: MapHostPorts` and a sibling-child import declared in `deps.json` (check `childBoundary.test.ts`); decide whether it replaces `MapDrawControls` or sits beside it.
