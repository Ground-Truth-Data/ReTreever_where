import type * as mapboxgl from "mapbox-gl";
import type { CentroidIds, Centroids } from "./whereTypes";

/** All features off by default; `fullMapOptions` and `compactGlobeOptions` are the presets. */
export interface MapOptions {
    showNavigation?: boolean;
    /** Defaults to `showNavigation`. */
    showScale?: boolean;
    /** Debug aid: a live "z3.4" readout bottom-right. */
    showZoomReadout?: boolean;
    cornerControlsBottomRight?: boolean;
    /** Attribution bottom-left, wordmark bottom-right. Construction-time only: mapbox never moves them after. */
    creditsSplit?: boolean;
    showStyleControl?: boolean;
    showGeoToggle?: boolean;
    showDrawTools?: boolean;
    /** No zoom buttons, FAB-driven draw, top-right style toggle. */
    mobileControls?: boolean;

    enableHash?: boolean;
    /** A SvelteKit host passes `replaceState`; omitted, `history.replaceState`. The child has no router of its own. */
    writeHash?: (url: string) => void;

    compact?: boolean;
    globeProjection?: boolean;
    autoRotate?: boolean;
    /** Degrees per second. */
    rotationSpeed?: number;
    hideLabels?: boolean;
    /** Layer id prefixes kept visible when hideLabels is on. */
    labelWhitelist?: string[];
    transparentBackground?: boolean;

    scrollZoom?: boolean;
    initialZoom?: number;
    initialCenter?: [number, number];
    markerSvg?: string;
    /** Land GeoJSON endpoint: `?bbox=` for polygons in view, `?id=` / `?land=` for one with its names. */
    polygonsUrl?: string;
    /** The pins, started by the host before the map asks; with `loadMarkers`, drawn clustered. */
    centroids?: Promise<Centroids | null>;
    /** The pins' polygon keys, in flight beside `centroids`; awaited on the first pin click, never before. */
    centroidIds?: Promise<CentroidIds | null>;
    loadMarkers?: boolean;
    style?: string;
    /** Lets a caller rewrite or block every tile/asset request. */
    transformRequest?: mapboxgl.MapboxOptions["transformRequest"];

    onUserInteractionStart?: () => void;
    onUserInteractionEnd?: () => void;
    /** Receives the feature's GeoJSON `properties` bag; shape varies per layer. */
    onFeatureSelect?: (feature: Record<string, unknown>) => void;
    onMapReady?: (map: import("mapbox-gl").Map) => void;
    /** Fires at construction, before the style loads: on a weak connection `load` can hang for minutes, and DOM markers work on a bare map. */
    onMapCreated?: (map: import("mapbox-gl").Map) => void;
}

export interface PolygonConfig {
    id: string;
    path: string;
    name: string;
    fillColor: string;
    outlineColor: string;
    opacity: number;
    type?: string;
    initiallyVisible?: boolean;
}

