import mapboxgl from "mapbox-gl";
import workerUrl from "mapbox-gl/dist/mapbox-gl-csp-worker.js?url";

// Mapbox's default worker is rebuilt from its bundled source, which the production bundle breaks.
// Built only: `vite dev` serves the file through its transform, which prepends an ES import that a
// classic worker cannot parse, so the map never loads.
if (import.meta.env.PROD) mapboxgl.workerUrl = workerUrl;
