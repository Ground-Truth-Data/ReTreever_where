// Natural Dark: runtime overrides on Mapbox dark-v11. Raster sources (DEM,
// satellite) are gated behind minzoom so they never fetch at globe scale.
import type * as mapboxgl from "mapbox-gl";

const P = {
    land: "#2f5a32", // lighter so gold pins pop
    ocean: "#0d2038",
    waterway: "rgba(13, 40, 80, 0.7)",
    lc: {
        wood: "rgba(22, 62, 28, 0.55)",
        grass: "rgba(32, 54, 22, 0.45)",
        crop: "rgba(40, 50, 20, 0.38)",
        scrub: "rgba(28, 46, 24, 0.38)",
        snow: "rgba(42, 52, 68, 0.32)",
    },
    contour: "rgba(255, 255, 255, 0.06)",
    hs: {
        shadow: "rgba(0, 0, 0, 0.15)",
        highlight: "rgba(255, 255, 255, 0.05)",
    },
} as const;

const SAT_MIN_ZOOM = 10;
const SAT_FULL_ZOOM = 15;
const SAT_OPACITY = 0.85;

export const NATURAL_FOG: mapboxgl.FogSpecification = {
    color: "rgba(12, 30, 22, 0.28)",
    "high-color": "rgba(8, 20, 55, 0.22)",
    "horizon-blend": 0.02,
    "space-color": "rgb(8, 10, 20)",
    "star-intensity": 0.5,
};

const HIDE_PREFIXES = [
    "road",
    "bridge",
    "tunnel",
    "transit",
    "aeroway",
    "building",
    "poi",
    "place-",
    "settlement",
    "natural-point",
    "natural-line",
    "waterway-label",
    "water-point",
    "water-line",
    "admin",
];

function shouldHide(id: string, type: string): boolean {
    if (type === "symbol") return true;
    return HIDE_PREFIXES.some((p) => id.startsWith(p));
}

// getLayer first, never try/catch: Mapbox console.errors a missing layer BEFORE
// it throws, and base layers are renamed between style versions.
function setPaint<K extends keyof mapboxgl.PaintSpecification>(
    map: mapboxgl.Map,
    id: string,
    prop: K,
    value: mapboxgl.PaintSpecification[K],
): void {
    if (!map.getLayer(id)) return;
    map.setPaintProperty(id, prop, value);
}

function hide(map: mapboxgl.Map, id: string): void {
    if (!map.getLayer(id)) return;
    map.setLayoutProperty(id, "visibility", "none");
}

export function applyNaturalOverrides(map: mapboxgl.Map): void {
    const layers = map.getStyle()?.layers;
    if (!layers) return;

    // By type, not id: dark-v11 does not call its background layer "background".
    for (const l of layers) {
        if (l.type === "background") {
            setPaint(map, l.id, "background-color", P.land);
        }
    }
    for (const l of layers) {
        if (/^water/.test(l.id) && l.type === "fill") {
            setPaint(map, l.id, "fill-color", P.ocean);
        }
    }

    for (const l of layers) {
        if (/^waterway/.test(l.id) && l.type === "line") {
            setPaint(map, l.id, "line-color", P.waterway);
            setPaint(map, l.id, "line-opacity", 0.8);
        }
    }

    for (const l of layers) {
        if (shouldHide(l.id, l.type)) hide(map, l.id);
    }

    for (const l of layers) {
        if (/^landuse/.test(l.id) && l.type === "fill") {
            setPaint(map, l.id, "fill-color", "rgba(26, 48, 24, 0.25)");
        }
    }

    addLandcover(map);

    // Raster layers load on idle so no raster work happens during gestures.
    setupLazyTerrain(map);
    setupLazySatellite(map);
}

function addLandcover(map: mapboxgl.Map): void {
    const src = "natural-terrain";
    if (!map.getSource(src)) {
        map.addSource(src, {
            type: "vector",
            url: "mapbox://mapbox.mapbox-terrain-v2",
        });
    }

    for (const [cls, color] of Object.entries(P.lc)) {
        const id = `natural-lc-${cls}`;
        if (map.getLayer(id)) continue;
        map.addLayer({
            id,
            type: "fill",
            source: src,
            "source-layer": "landcover",
            filter: ["==", "class", cls],
            paint: {
                "fill-color": color,
                "fill-antialias": false,
            },
        });
    }
}

const TERRAIN_MIN_ZOOM = 9;

function setupLazyTerrain(map: mapboxgl.Map): void {
    let added = false;

    function onIdle() {
        if (added) return;
        if (map.getZoom() < TERRAIN_MIN_ZOOM) return;

        added = true;
        map.off("idle", onIdle);

        if (!map.getSource("natural-dem")) {
            map.addSource("natural-dem", {
                type: "raster-dem",
                url: "mapbox://mapbox.terrain-rgb",
                tileSize: 256,
            });
        }
        // 3D terrain recurses the globe camera and blows the stack; hillshade still works.
        map.setTerrain(null);
        if (!map.getLayer("natural-hillshade")) {
            map.addLayer({
                id: "natural-hillshade",
                type: "hillshade",
                source: "natural-dem",
                minzoom: TERRAIN_MIN_ZOOM,
                paint: {
                    "hillshade-shadow-color": P.hs.shadow,
                    "hillshade-highlight-color": P.hs.highlight,
                    "hillshade-accent-color": "rgba(0, 0, 0, 0)",
                    "hillshade-exaggeration": 0.4,
                },
            });
        }

        if (!map.getLayer("natural-contours")) {
            map.addLayer({
                id: "natural-contours",
                type: "line",
                source: "natural-terrain",
                "source-layer": "contour",
                filter: ["==", "index", 5],
                minzoom: TERRAIN_MIN_ZOOM,
                paint: {
                    "line-color": P.contour,
                    "line-width": [
                        "interpolate",
                        ["linear"],
                        ["zoom"],
                        9,
                        0.3,
                        12,
                        0.6,
                        14,
                        0.8,
                    ],
                },
            });
        }
    }

    map.on("idle", onIdle);
}

// The layer persists once added; hide/show toggling on gestures flashes.
function setupLazySatellite(map: mapboxgl.Map): void {
    let added = false;

    function onIdle() {
        if (added) return;
        if (map.getZoom() < SAT_MIN_ZOOM) return;

        added = true;
        map.off("idle", onIdle);

        if (!map.getSource("natural-satellite")) {
            map.addSource("natural-satellite", {
                type: "raster",
                url: "mapbox://mapbox.satellite",
                tileSize: 256,
            });
        }

        if (!map.getLayer("natural-sat")) {
            const dataLayer = map
                .getStyle()
                ?.layers?.find(
                    (l) =>
                        l.id.startsWith("hero-marker") ||
                        l.id.startsWith("polygon") ||
                        l.id.startsWith("large-polygon"),
                );

            map.addLayer(
                {
                    id: "natural-sat",
                    type: "raster",
                    source: "natural-satellite",
                    minzoom: SAT_MIN_ZOOM,
                    paint: {
                        "raster-opacity": [
                            "interpolate",
                            ["linear"],
                            ["zoom"],
                            SAT_MIN_ZOOM,
                            0,
                            SAT_FULL_ZOOM,
                            SAT_OPACITY,
                        ],
                        "raster-fade-duration": 500,
                    },
                },
                dataLayer?.id,
            );
        }
    }

    map.on("idle", onIdle);
}
