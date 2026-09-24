import defaultMarkerUrl from "./assets/mobileAssets/map-marker-osem-people.svg";
import type { MapOptions } from "./mapTypes";

const markerSize = 28;

export const MAP_CONFIG = {
    markerSize,
    markers: {
        default: defaultMarkerUrl,
    },
    styles: {
        defaultSat: "mapbox://styles/mapbox/satellite-streets-v12",
        defaultDark: "mapbox://styles/mapbox/dark-v11",
    },
    cluster: {
        maxZoom: 14,
        radius: 45,
        clickZoom: 14,
        // Transparent fill: the gold glow shines through the white ring.
        circleStops: [
            { count: 1, radius: 8, color: "rgba(255, 255, 255, 0)" },
            { count: 10, radius: 14, color: "rgba(255, 255, 255, 0)" },
            { count: 50, radius: 22, color: "rgba(255, 255, 255, 0)" },
            { count: 200, radius: 34, color: "rgba(255, 255, 255, 0)" },
        ],
        stroke: {
            color: "rgba(255, 255, 255, 0.95)",
            width: 1.5,
        },
        glow: {
            color: "rgba(255, 200, 0, 0.45)",
            radiusScale: 1.25,
            blur: 0.35,
        },
        heatmap: {
            minZoom: 0,
            maxZoom: 7,
            ramp: [
                { stop: 0, color: "rgba(0, 0, 0, 0)" },
                { stop: 0.2, color: "rgba(120, 80, 0, 0.55)" },
                { stop: 0.4, color: "rgba(255, 180, 0, 0.75)" },
                { stop: 0.7, color: "rgba(255, 215, 0, 0.9)" },
                { stop: 1, color: "rgba(255, 245, 200, 0.9)" },
            ],
        },
    },
    marker: {
        width: markerSize,
        height: markerSize,
        alt: "map Pin",
        iconPixelSize: 56,
        iconSize: 1.1,
    },
    globe: {
        rotationSpeed: 1.5,
        maxSpinZoom: 4,
        duration: 1000,
    },
    // Elastic zoom: pinch `overshoot` past the soft limits, then ease back.
    zoom: {
        softMin: 0.5,
        softMax: 20,
        overshoot: 0.6,
        easeMs: 250,
    },
} as const;

export const defaultOptions = {
    compact: false,
    showNavigation: false,
    showStyleControl: false,
    showGeoToggle: false,
    showDrawTools: false,
    enableHash: false,
    globeProjection: false,
    autoRotate: false,
    rotationSpeed: 2,
    scrollZoom: true,
    initialZoom: 2,
    initialCenter: [38.32379156163088, -4.920169086710128], // Tanzania
    style: MAP_CONFIG.styles.defaultSat,
} satisfies MapOptions;

export const fullMapOptions: MapOptions = {
    showNavigation: true,
    showStyleControl: true,
    showGeoToggle: false,
    showDrawTools: false,
    hideLabels: true,
    enableHash: true,
    globeProjection: true,
    autoRotate: true,
    rotationSpeed: 2,
    scrollZoom: true,
    initialZoom: 2,
    initialCenter: [38.32379156163088, -4.920169086710128],
    style: MAP_CONFIG.styles.defaultSat,
};

export const compactGlobeOptions: MapOptions = {
    hideLabels: true,
    globeProjection: true,
    autoRotate: true,
    rotationSpeed: 1.5,
    style: MAP_CONFIG.styles.defaultDark,
};
