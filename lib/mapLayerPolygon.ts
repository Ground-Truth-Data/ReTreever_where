import type {
    Feature,
    FeatureCollection,
    GeoJsonProperties,
    MultiPolygon,
    Point,
    Polygon,
} from "geojson";
import type * as mapboxgl from "mapbox-gl";
import mapboxglRuntime from "mapbox-gl";
import { MAP_CONFIG } from "./MAP_CONFIG";
import { addClusteredPins, isMapAlive } from "./mapMarker";
import type { MapOptions } from "./mapTypes";
import { safeEase } from "./safeEase";

const POLYGON_STYLE = {
    fillColor: "rgba(255, 215, 0, 0.25)",
    fillOpacity: 0.3,
    outlineColor: "rgba(255, 255, 255, 0.85)",
    outlineWidth: 1.5,
    minZoom: 7,
} as const;

const PINS_ID = "hero-marker";
const PINS_GLOW_LAYER = `${PINS_ID}-cluster-glow`;
const PREVIEW_SOURCE_ID = "large-polygon-preview";
const PREVIEW_FILL_LAYER = "large-polygon-preview-fill";
const PREVIEW_OUTLINE_LAYER = "large-polygon-preview-outline";

// Mirrors the API's thresholds, for the popup only.
const LARGE_POLYGON_HA = 1_000;
const ABSOLUTE_CAP_HA = 50_000;

function emptyFC(): FeatureCollection {
    return { type: "FeatureCollection", features: [] };
}

function showLargePolygonPopup(
    map: mapboxgl.Map,
    lngLat: [number, number],
    hectares: number | null,
    isAbsolute: boolean,
): void {
    const limit = (isAbsolute ? ABSOLUTE_CAP_HA : LARGE_POLYGON_HA).toLocaleString();
    const ha =
        hectares !== null ? Math.round(hectares).toLocaleString() : "unknown";
    const row = (label: string, value: string) =>
        `<div style="display:flex;justify-content:space-between;gap:1rem;font-size:0.8rem;">` +
        `<span style="color:#9ca3af;">${label}</span><span style="color:#e5e7eb;">${value}</span></div>`;

    new mapboxglRuntime.Popup({
        closeButton: false,
        closeOnClick: true,
        anchor: "top",
        offset: 8,
        className: "large-poly-popup",
    })
        .setLngLat(lngLat)
        .setHTML(
            `<div style="background:#1a1a1a;border:1px solid #555;border-radius:0.5rem;padding:0.75rem 1rem;max-width:220px;box-shadow:-0.25rem 0 1rem rgba(0,0,0,0.3);">` +
                row("Hectares:", ha) +
                row("Limit:", `${limit} ha`) +
                `<p style="color:#d4d4d8;font-size:0.75rem;margin:0.5rem 0 0;line-height:1.3;border-top:1px solid #444;padding-top:0.4rem;">` +
                `Polygon exceeds limit. Not meaningful restoration data.</p></div>`,
        )
        .addTo(map);
}

function addPolygonLayers(
    map: mapboxgl.Map,
    sourceId: string,
    fillId: string,
    outlineId: string,
): void {
    // Below the cluster glow, or the fill tints the gold halo.
    const beforeId = map.getLayer(PINS_GLOW_LAYER) ? PINS_GLOW_LAYER : undefined;
    map.addLayer(
        {
            id: fillId,
            type: "fill",
            source: sourceId,
            minzoom: POLYGON_STYLE.minZoom,
            paint: {
                "fill-color": POLYGON_STYLE.fillColor,
                "fill-opacity": POLYGON_STYLE.fillOpacity,
            },
        },
        beforeId,
    );
    map.addLayer(
        {
            id: outlineId,
            type: "line",
            source: sourceId,
            minzoom: POLYGON_STYLE.minZoom,
            paint: {
                "line-color": POLYGON_STYLE.outlineColor,
                "line-width": POLYGON_STYLE.outlineWidth,
            },
        },
        beforeId,
    );
}

/**
 * Land as clustered centroid pins, plus full polygon geometry fetched once the
 * camera nears `POLYGON_STYLE.minZoom` — the globe loads on Points alone.
 */
export async function addMarkersLayer(
    map: mapboxgl.Map,
    options: MapOptions = {},
): Promise<void> {
    const polygonsUrl = options.polygonsUrl;
    if (!polygonsUrl) return;
    const withQuery = (q: string) =>
        `${polygonsUrl}${polygonsUrl.includes("?") ? "&" : "?"}${q}`;

    let centroidsData: { features?: Feature<Point, GeoJsonProperties>[] } | null;
    try {
        const response = await fetch(withQuery("mode=centroids"));
        if (!isMapAlive(map)) return;
        if (!response.ok) {
            console.error("Failed to fetch polygon centroids:", response.status);
            return;
        }
        centroidsData = await response.json();
        if (!isMapAlive(map)) return;
    } catch (err) {
        console.error("Error fetching polygon centroids:", err);
        return;
    }

    const centroidFeatures = (centroidsData?.features ?? []).filter((f) => {
        const c = f.geometry?.coordinates;
        return (
            Array.isArray(c) &&
            c.length === 2 &&
            Number.isFinite(c[0]) &&
            Number.isFinite(c[1]) &&
            Math.abs(c[0]) >= 1 &&
            Math.abs(c[1]) >= 1
        );
    });

    let fullPolygonsLoaded = false;
    let fullPolygonsInflight: Promise<void> | null = null;

    function bindPolygonClicks(): void {
        if (options.compact) return;
        map.on("click", "polygons-fill", (e) => {
            const properties = map.queryRenderedFeatures(e.point, {
                layers: ["polygons-fill"],
            })[0]?.properties;
            if (!properties) return;

            const centroid = properties.centroid as
                | { coordinates?: [number, number] }
                | undefined;
            const center =
                centroid && typeof centroid === "object" && centroid.coordinates
                    ? centroid.coordinates
                    : (e.lngLat.toArray() as [number, number]);

            safeEase(map, { center, zoom: MAP_CONFIG.cluster.clickZoom });
            options.onFeatureSelect?.(properties);
        });
        map.on("mouseenter", "polygons-fill", () => {
            map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "polygons-fill", () => {
            map.getCanvas().style.cursor = "";
        });
    }

    async function ensureFullPolygons(): Promise<void> {
        if (fullPolygonsLoaded) return;
        if (fullPolygonsInflight) return fullPolygonsInflight;

        fullPolygonsInflight = (async () => {
            try {
                const response = await fetch(polygonsUrl as string);
                if (!isMapAlive(map)) return;
                if (!response.ok) {
                    console.error(
                        "Failed to fetch polygon geometries:",
                        response.status,
                    );
                    return;
                }
                const polygonData: { features?: Feature[] } =
                    await response.json();
                if (!isMapAlive(map)) return;
                // Null geometry = too large to ship; those draw on demand as a preview.
                const withGeometry = (polygonData.features ?? []).filter(
                    (f) => f.geometry !== null,
                );
                if (withGeometry.length === 0) return;

                const polygonFC: FeatureCollection = {
                    type: "FeatureCollection",
                    features: withGeometry,
                };
                const existing = map.getSource("polygons") as
                    | mapboxgl.GeoJSONSource
                    | undefined;
                if (existing) {
                    existing.setData(polygonFC);
                } else {
                    map.addSource("polygons", { type: "geojson", data: polygonFC });
                    addPolygonLayers(map, "polygons", "polygons-fill", "polygons-outline");
                    bindPolygonClicks();
                }
                fullPolygonsLoaded = true;
            } catch (err) {
                console.error("Error fetching polygon geometries:", err);
            } finally {
                fullPolygonsInflight = null;
            }
        })();
        return fullPolygonsInflight;
    }

    // One step early, so geometry has usually landed by the time fills show.
    const loadTriggerZoom = Math.max(POLYGON_STYLE.minZoom - 1, 4);
    const maybeLoadOnZoom = () => {
        if (map.getZoom() >= loadTriggerZoom) void ensureFullPolygons();
    };
    map.on("zoomend", maybeLoadOnZoom);
    maybeLoadOnZoom();

    addClusteredPins(map, {
        id: PINS_ID,
        data: { type: "FeatureCollection", features: centroidFeatures },
        markerUrl: options.markerUrl,
        onPointClick: async (feature) => {
            if (options.compact) return;
            const coordinates = (
                feature.geometry as Point
            ).coordinates.slice() as [number, number];
            const properties = feature.properties;
            if (!properties) return;

            safeEase(map, {
                center: coordinates,
                zoom: MAP_CONFIG.cluster.clickZoom,
            });

            const polygonId = properties.polygonId as string | undefined;
            const hectares = (properties.hectaresCalc as number | null) ?? null;

            if (properties.isAbsoluteTooLarge) {
                showLargePolygonPopup(map, coordinates, hectares, true);
            } else if (properties.isLargePolygon && polygonId) {
                try {
                    const response = await fetch(
                        withQuery(`id=${encodeURIComponent(polygonId)}`),
                    );
                    if (!isMapAlive(map)) return;
                    if (response.ok) {
                        const featureData = (await response.json()) as Feature<
                            Polygon | MultiPolygon,
                            GeoJsonProperties
                        >;
                        if (!isMapAlive(map)) return;
                        if (featureData.geometry) {
                            (
                                map.getSource(PREVIEW_SOURCE_ID) as
                                    | mapboxgl.GeoJSONSource
                                    | undefined
                            )?.setData({
                                type: "FeatureCollection",
                                features: [featureData],
                            });
                        }
                    } else if (response.status === 413) {
                        showLargePolygonPopup(map, coordinates, hectares, true);
                    }
                } catch (err) {
                    console.error("Failed to fetch large polygon:", err);
                }
            }

            options.onFeatureSelect?.(properties);
        },
    });

    if (!map.getSource(PREVIEW_SOURCE_ID)) {
        map.addSource(PREVIEW_SOURCE_ID, { type: "geojson", data: emptyFC() });
        addPolygonLayers(map, PREVIEW_SOURCE_ID, PREVIEW_FILL_LAYER, PREVIEW_OUTLINE_LAYER);
    }

    // Only a click on empty canvas clears the preview; DOM and feature clicks leave it.
    const mapRecord = map as unknown as Record<string, unknown>;
    if (!mapRecord.__previewDismissBound) {
        mapRecord.__previewDismissBound = true;
        map.on("click", (e) => {
            const interactiveLayers = [
                PREVIEW_FILL_LAYER,
                "polygons-fill",
                `${PINS_ID}-clusters`,
            ].filter((id) => map.getLayer(id));
            if (interactiveLayers.length === 0) return;
            if (
                map.queryRenderedFeatures(e.point, { layers: interactiveLayers })
                    .length > 0
            )
                return;
            (
                map.getSource(PREVIEW_SOURCE_ID) as
                    | mapboxgl.GeoJSONSource
                    | undefined
            )?.setData(emptyFC());
        });
    }
}
