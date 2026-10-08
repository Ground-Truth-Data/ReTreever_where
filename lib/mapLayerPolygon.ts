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

// Requests snap to this grid, so a repeat view asks for the same URL and the CDN can answer it.
const CELL_DEG = 1;
const COLS = 360 / CELL_DEG;
const ROWS = 180 / CELL_DEG;
// Fraction of the view loaded beyond each edge, so a short pan doesn't pop.
const VIEW_PAD = 0.15;

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

    const loadedCells = new Set<string>();
    const polygonFeatures = new Map<string | number, Feature>();
    type CellBox = { c0: number; c1: number; r0: number; r1: number };
    let inflight: { controller: AbortController; box: CellBox } | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

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

    /** The smallest grid-aligned box holding every unloaded cell of the padded view. */
    function missingCells(): CellBox | null {
        const bounds = map.getBounds();
        if (!bounds) return null;
        const west = bounds.getWest();
        const east = bounds.getEast();
        const south = bounds.getSouth();
        const north = bounds.getNorth();
        const padX = (east - west) * VIEW_PAD;
        const padY = (north - south) * VIEW_PAD;
        // Columns stay unwrapped (may run past ±180) so a view across the antimeridian is one range.
        let c0 = Math.floor((west - padX + 180) / CELL_DEG);
        let c1 = Math.floor((east + padX + 180) / CELL_DEG);
        if (c1 - c0 + 1 >= COLS) [c0, c1] = [0, COLS - 1];
        const r0 = Math.max(0, Math.floor((south - padY + 90) / CELL_DEG));
        const r1 = Math.min(ROWS - 1, Math.floor((north + padY + 90) / CELL_DEG));

        let box: CellBox | null = null;
        for (let c = c0; c <= c1; c++) {
            for (let r = r0; r <= r1; r++) {
                if (loadedCells.has(cellKey(c, r))) continue;
                box = box
                    ? {
                          c0: Math.min(box.c0, c),
                          c1: Math.max(box.c1, c),
                          r0: Math.min(box.r0, r),
                          r1: Math.max(box.r1, r),
                      }
                    : { c0: c, c1: c, r0: r, r1: r };
            }
        }
        return box;
    }

    function cellKey(c: number, r: number): string {
        return `${((c % COLS) + COLS) % COLS}:${r}`;
    }

    function bboxParam(box: CellBox): string {
        const lon = (c: number) => (((c % COLS) + COLS) % COLS) * CELL_DEG - 180;
        const west = box.c1 - box.c0 + 1 >= COLS ? -180 : lon(box.c0);
        const eastRaw = lon(box.c1 + 1);
        // lon() lands on [-180, 180); an east edge at -180 is the antimeridian, i.e. 180.
        const east = box.c1 - box.c0 + 1 >= COLS || eastRaw === -180 ? 180 : eastRaw;
        const south = box.r0 * CELL_DEG - 90;
        const north = (box.r1 + 1) * CELL_DEG - 90;
        return `${west},${south},${east},${north}`;
    }

    function mergePolygons(features: Feature[]): void {
        for (const f of features) {
            if (f.geometry !== null && f.id != null) polygonFeatures.set(f.id, f);
        }
        const polygonFC: FeatureCollection = {
            type: "FeatureCollection",
            features: [...polygonFeatures.values()],
        };
        const existing = map.getSource("polygons") as mapboxgl.GeoJSONSource | undefined;
        if (existing) {
            existing.setData(polygonFC);
        } else {
            map.addSource("polygons", { type: "geojson", data: polygonFC });
            addPolygonLayers(map, "polygons", "polygons-fill", "polygons-outline");
            bindPolygonClicks();
        }
    }

    async function loadViewPolygons(): Promise<void> {
        if (!isMapAlive(map)) return;
        const box = missingCells();
        if (!box) return;
        const pending = inflight?.box;
        if (
            pending &&
            box.c0 >= pending.c0 &&
            box.c1 <= pending.c1 &&
            box.r0 >= pending.r0 &&
            box.r1 <= pending.r1
        )
            return;
        inflight?.controller.abort();
        const controller = new AbortController();
        inflight = { controller, box };
        try {
            const response = await fetch(withQuery(`bbox=${bboxParam(box)}`), {
                signal: controller.signal,
            });
            if (!isMapAlive(map)) return;
            if (!response.ok) {
                console.error("Failed to fetch polygon geometries:", response.status);
                return;
            }
            const polygonData: { features?: Feature[] } = await response.json();
            if (!isMapAlive(map)) return;
            // Null geometry = too large to ship; those draw on demand as a preview.
            mergePolygons(polygonData.features ?? []);
            for (let c = box.c0; c <= box.c1; c++) {
                for (let r = box.r0; r <= box.r1; r++) loadedCells.add(cellKey(c, r));
            }
        } catch (err) {
            if (controller.signal.aborted) return;
            console.error("Error fetching polygon geometries:", err);
        } finally {
            if (inflight?.controller === controller) inflight = null;
        }
    }

    // Half a step early, so geometry has usually landed by the time fills show.
    const loadTriggerZoom = POLYGON_STYLE.minZoom - 0.5;
    const maybeLoadView = () => {
        clearTimeout(debounceTimer);
        if (map.getZoom() < loadTriggerZoom) return;
        debounceTimer = setTimeout(() => void loadViewPolygons(), 250);
    };
    map.on("moveend", maybeLoadView);
    maybeLoadView();

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
