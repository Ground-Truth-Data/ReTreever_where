import mapboxgl from "mapbox-gl";
import workerUrl from "mapbox-gl/dist/mapbox-gl-csp-worker.js?url";

// Mapbox's default worker is rebuilt from its bundled source, which the production bundle breaks.
mapboxgl.workerUrl = workerUrl;
