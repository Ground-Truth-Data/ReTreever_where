import mapboxgl from "mapbox-gl";
import workerUrl from "mapbox-gl/dist/mapbox-gl-csp-worker.js?url";

// Mapbox's default worker is rebuilt from its bundled source, which the production bundle breaks.
// Vite's dev server would serve the file as a module, which a classic worker can't parse; this query is Vite's classic-worker path.
mapboxgl.workerUrl = import.meta.env.DEV ? `${workerUrl}${workerUrl.includes("?") ? "&" : "?"}worker_file&type=classic` : workerUrl;
