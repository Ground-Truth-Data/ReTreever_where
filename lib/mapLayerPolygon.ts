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
import { m } from "$parent/src/lib/paraglide/messages";
import { getLocale } from "$parent/src/lib/paraglide/runtime";
import { pinAt, pinsFromCentroids } from "./centroidPins";
import { featureCoord } from "./coord";
import { MAP_CONFIG } from "./MAP_CONFIG";
import { addClusteredPins, isMapAlive } from "./mapMarker";
import type { MapOptions } from "./mapTypes";
import { safeEase } from "./safeEase";
import type { Centroids, PolygonTiles } from "./whereTypes";

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

/** `performance.getEntriesByName("where-pins")` reads when the first pins were handed to the map. */
const PINS_MARK = "where-pins";
/** And `"where-fill"` when the first `polygons` tile holding a feature had loaded. */
const FILL_MARK = "where-fill";
const POLYGONS_SOURCE = "polygons";
/** The one layer a polygon tile carries. */
const TILE_LAYER = "polygons";

function emptyFC(): FeatureCollection {
    return { type: "FeatureCollection", features: [] };
}

function showLargePolygonPopup(
    map: mapboxgl.Map,
    lngLat: [number, number],
    hectares: number | null,
    isAbsolute: boolean,
): void {
    const limit = (isAbsolute ? ABSOLUTE_CAP_HA : LARGE_POLYGON_HA).toLocaleString(getLocale());
    const ha =
        hectares !== null
            ? Math.round(hectares).toLocaleString(getLocale())
            : m.wh_large_polygon_hectares_unknown();
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
                row(m.wh_row_hectares(), ha) +
                row(m.wh_large_polygon_limit(), `${limit} ha`) +
                `<p style="color:#d4d4d8;font-size:0.75rem;margin:0.5rem 0 0;line-height:1.3;border-top:1px solid #444;padding-top:0.4rem;">` +
                `${m.wh_large_polygon_note()}</p></div>`,
        )
        .addTo(map);
}

function addPolygonLayers(
    map: mapboxgl.Map,
    sourceId: string,
    fillId: string,
    outlineId: string,
    sourceLayer?: string,
): void {
    // Below the cluster glow, or the fill tints the gold halo.
    const beforeId = map.getLayer(PINS_GLOW_LAYER) ? PINS_GLOW_LAYER : undefined;
    map.addLayer(
        {
            id: fillId,
            type: "fill",
            source: sourceId,
            ...(sourceLayer && { "source-layer": sourceLayer }),
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
            ...(sourceLayer && { "source-layer": sourceLayer }),
            minzoom: POLYGON_STYLE.minZoom,
            paint: {
                "line-color": POLYGON_STYLE.outlineColor,
                "line-width": POLYGON_STYLE.outlineWidth,
            },
        },
        beforeId,
    );
}

function markFirstFill(map: mapboxgl.Map, sourceLayer?: string): void {
    if (typeof performance === "undefined" || performance.getEntriesByName(FILL_MARK).length) return;
    const onData = (e: mapboxgl.MapSourceDataEvent) => {
        if (e.sourceId !== POLYGONS_SOURCE || !e.isSourceLoaded) return;
        if (!map.querySourceFeatures(POLYGONS_SOURCE, sourceLayer ? { sourceLayer } : {}).length) return;
        map.off("sourcedata", onData);
        if (!performance.getEntriesByName(FILL_MARK).length) performance.mark(FILL_MARK);
    };
    map.on("sourcedata", onData);
}

type TransformRequest = NonNullable<MapOptions["transformRequest"]>;

// The map's `transformRequest` is fixed at construction; this is how a page that takes a newer build repoints it.
const tileUrlSetters = new WeakMap<PolygonTiles, (tileUrl: PolygonTiles["tileUrl"]) => void>();

const TEMPLATE_TAIL = "/polygons/{z}/{x}/{y}.pbf";
const BUILD_ID = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;

async function readJson(url: string): Promise<Record<string, unknown> | null> {
    const res = await fetch(url);
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
}

/**
 * The store's live build, read from beside the tiles the page holds: its pins and its fills, or null when the
 * page already holds it or any file of it does not read. The layout under `builds/` is the host's
 * (`latest.json` naming the build; `pins.json` and `index.json` under it, the index giving each `z/x/y` the
 * build that last changed its tile).
 */
async function readLiveBuild(held: PolygonTiles): Promise<{ centroids: Centroids; tiles: PolygonTiles } | null> {
    if (!held.tiles.endsWith(TEMPLATE_TAIL)) return null;
    const root = held.tiles.slice(0, -TEMPLATE_TAIL.length);
    const latest = await readJson(`${root}/builds/latest.json`);
    const build = latest?.build;
    if (typeof build !== "string" || !BUILD_ID.test(build) || build === held.build) return null;
    const { minzoom, maxzoom } = latest as { minzoom?: unknown; maxzoom?: unknown };
    if (typeof minzoom !== "number" || typeof maxzoom !== "number") return null;
    const [pins, index] = await Promise.all([
        readJson(`${root}/builds/${build}/pins.json`),
        readJson(`${root}/builds/${build}/index.json`),
    ]);
    if (pins?.build !== build || !Array.isArray(pins.lonlat) || !Array.isArray(pins.large)) return null;
    const since = index?.since;
    const tiles = index?.tiles as Record<string, number> | null | undefined;
    if (index?.build !== build || !Array.isArray(since) || !since.every((b) => typeof b === "string" && BUILD_ID.test(b))) return null;
    if (!tiles || typeof tiles !== "object") return null;
    const prefix = `${root}/polygons/`;
    const tileUrl = (url: string) => {
        if (!url.startsWith(prefix)) return url;
        const key = /^(\d+\/\d+\/\d+)\.pbf$/.exec(url.slice(prefix.length))?.[1];
        if (!key) return url;
        const from = since[tiles[key]] as string | undefined;
        return from ? `${prefix}${key}/${from}.pbf` : `${prefix}empty.pbf`;
    };
    return {
        centroids: pins as unknown as Centroids,
        tiles: { build, tiles: held.tiles, minzoom, maxzoom, tileUrl },
    };
}

/**
 * Mapbox reads `transformRequest` only at construction, so the map is born with this one, which rewrites
 * `Tile` URLs once the tiles resolve. The returned `polygonTiles` settles only after that, so a source added
 * on it never asks for an unrewritten tile.
 */
export function polygonTileRequests(
    polygonTiles: Promise<PolygonTiles | null>,
    next?: TransformRequest,
): { polygonTiles: Promise<PolygonTiles | null>; transformRequest: TransformRequest } {
    let tileUrl: ((url: string) => string) | undefined;
    const ready = polygonTiles.then((tiles) => {
        tileUrl = tiles?.tileUrl;
        if (tiles) tileUrlSetters.set(tiles, (next) => (tileUrl = next));
        return tiles;
    });
    // The map still receives the rejection; this only keeps a map without markers from logging it unhandled.
    ready.catch(() => {});
    return {
        polygonTiles: ready,
        transformRequest: (url, resourceType) => {
            const to = resourceType === "Tile" && tileUrl ? tileUrl(url) : url;
            return next ? next(to, resourceType) : { url: to };
        },
    };
}

/**
 * Land as clustered pins from the host's centroids arrays, plus the small polygons' fills from
 * `polygonTiles` (or, without them, geometry fetched by `?bbox=` once the camera nears
 * `POLYGON_STYLE.minZoom`). A pin and a fill carry only their number in a build: a click asks
 * `?pin=<build>/<n>`, and the host resolves it. When the host no longer holds that build (an empty 204),
 * the page takes the live build's pins and tiles and asks once more, for the pin at the same place.
 */
export async function addMarkersLayer(
    map: mapboxgl.Map,
    options: MapOptions = {},
): Promise<void> {
    const polygonsUrl = options.polygonsUrl;
    if (!polygonsUrl) return;
    const withQuery = (q: string) =>
        `${polygonsUrl}${polygonsUrl.includes("?") ? "&" : "?"}${q}`;

    let centroids: Centroids | null = null;
    let pins: FeatureCollection<Point> | null = null;
    // A basemap switch (`setStyle`) drops every source and layer; these rebuild them from memory.
    let polygonSource: { spec: () => mapboxgl.AnySourceData; sourceLayer?: string; tiles?: PolygonTiles } | null = null;
    /** The tiles object the map was born with: `tileUrlSetters` knows it by identity. */
    let firstTiles: PolygonTiles | null = null;
    let takingLive: Promise<boolean> | null = null;
    let preview: FeatureCollection = emptyFC();
    let previewReady = false;
    let polygonClicksBound = false;
    let fillWatched = false;
    // Between `setStyle` and its `style.load` the style is half-built, and adding to it throws.
    let styleReady = true;
    const loadedCells = new Set<string>();
    const polygonFeatures = new Map<string | number, Feature>();
    type CellBox = { c0: number; c1: number; r0: number; r1: number };
    let inflight: { controller: AbortController; box: CellBox } | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const previewSource = () =>
        map.getSource(PREVIEW_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;

    function setPreview(fc: FeatureCollection): void {
        preview = fc;
        previewSource()?.setData(fc);
    }

    const ask = (pin: string) => fetch(withQuery(`pin=${encodeURIComponent(pin)}`));

    /** Swaps the pins and the fills to the store's live build; false when there is none newer to take. */
    function takeLiveBuild(): Promise<boolean> {
        takingLive ??= (async () => {
            const held = polygonSource?.tiles;
            const live = held ? await readLiveBuild(held) : null;
            if (!live || !isMapAlive(map)) return false;
            centroids = live.centroids;
            pins = pinsFromCentroids(centroids);
            installPins();
            if (firstTiles) tileUrlSetters.get(firstTiles)?.(live.tiles.tileUrl);
            // A new source, not a reload: the template is the same, and only a new source drops the old build's tiles.
            if (styleReady && map.getSource(POLYGONS_SOURCE)) {
                for (const id of ["polygons-fill", "polygons-outline"]) if (map.getLayer(id)) map.removeLayer(id);
                map.removeSource(POLYGONS_SOURCE);
            }
            addPolygonTiles(live.tiles);
            return true;
        })()
            .catch((err) => {
                console.error("Failed to read the live build:", err);
                return false;
            })
            .finally(() => {
                takingLive = null;
            });
        return takingLive;
    }

    /**
     * The drawer opens on the click at once and fills from `?pin=` — the one query a visitor waits
     * for. A large polygon's geometry comes in the same answer and draws as the preview. With no
     * pin to ask for (a tile from before pins were numbered), the drawer says so and asks nothing.
     */
    async function selectPolygon(
        build: string | undefined,
        n: unknown,
        center: [number, number],
    ): Promise<void> {
        if (options.compact) return;
        safeEase(map, { center, zoom: MAP_CONFIG.cluster.clickZoom });
        const centroid = { type: "Point", coordinates: center };
        options.onFeatureSelect?.({ centroid, loading: true });
        const pin = pinRef(build, n);
        // Read now: a recovery replaces `centroids`, and the place is all that names this pin in the next build.
        const heldPins = centroids;
        const at = pin && heldPins && heldPins.build === build ? heldPins.lonlat.slice(2 * (n as number), 2 * (n as number) + 2) : [];
        try {
            if (!pin) {
                options.onFeatureSelect?.({ centroid, failed: true });
                return;
            }
            let response = await ask(pin);
            if (!isMapAlive(map)) return;
            if (response.status === 204) {
                // Once per click: the second answer stands, whatever it is.
                const moved = centroids?.build !== build || (await takeLiveBuild());
                if (!isMapAlive(map)) return;
                const again = moved && centroids && at.length === 2 ? pinRef(centroids.build, pinAt(centroids, at[0], at[1])) : null;
                if (!again) {
                    console.error("Failed to fetch polygon: its build is gone, and no live build has a pin there");
                    options.onFeatureSelect?.({ centroid, failed: true });
                    return;
                }
                response = await ask(again);
                if (!isMapAlive(map)) return;
            }
            if (!response.ok || response.status === 204) {
                console.error("Failed to fetch polygon:", response.status);
                options.onFeatureSelect?.({ centroid, failed: true });
                return;
            }
            const feature = (await response.json()) as Feature<
                Polygon | MultiPolygon | null,
                GeoJsonProperties
            >;
            if (!isMapAlive(map)) return;
            const properties = feature.properties ?? {};
            const hectares = (properties.hectaresCalc as number | null) ?? null;
            if (properties.isAbsoluteTooLarge) {
                showLargePolygonPopup(map, center, hectares, true);
            } else if (properties.isLargePolygon && feature.geometry) {
                setPreview({
                    type: "FeatureCollection",
                    features: [feature as Feature<Polygon | MultiPolygon>],
                });
            }
            options.onFeatureSelect?.(properties);
        } catch (err) {
            console.error("Failed to fetch polygon:", err);
            if (isMapAlive(map)) options.onFeatureSelect?.({ centroid, failed: true });
        }
    }

    const pinRef = (build: string | undefined, pin: unknown) =>
        build && typeof pin === "number" && Number.isInteger(pin) && pin >= 0 ? `${build}/${pin}` : null;

    function bindPolygonClicks(): void {
        if (options.compact || polygonClicksBound) return;
        polygonClicksBound = true;
        map.on("click", "polygons-fill", (e) => {
            // A pin sits inside its own fill; its handler owns that click, or `?id=` is asked twice.
            const pinLayers = [`${PINS_ID}-dogs`, `${PINS_ID}-clusters`].filter((id) => map.getLayer(id));
            if (pinLayers.length && map.queryRenderedFeatures(e.point, { layers: pinLayers }).length) return;
            const properties = map.queryRenderedFeatures(e.point, {
                layers: ["polygons-fill"],
            })[0]?.properties;
            if (!properties) return;
            const center = featureCoord(properties) ?? (e.lngLat.toArray() as [number, number]);
            void selectPolygon(polygonSource?.tiles?.build, properties.pin, [center[0], center[1]]);
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

    function installPolygons(): void {
        if (!polygonSource || !styleReady || map.getSource(POLYGONS_SOURCE)) return;
        const { spec, sourceLayer } = polygonSource;
        map.addSource(POLYGONS_SOURCE, spec());
        addPolygonLayers(map, POLYGONS_SOURCE, "polygons-fill", "polygons-outline", sourceLayer);
        bindPolygonClicks();
        if (!fillWatched) {
            fillWatched = true;
            markFirstFill(map, sourceLayer);
        }
    }

    const polygonFC = (): FeatureCollection => ({
        type: "FeatureCollection",
        features: [...polygonFeatures.values()],
    });

    function mergePolygons(features: Feature[]): void {
        for (const f of features) {
            if (f.geometry !== null && f.id != null) polygonFeatures.set(f.id, f);
        }
        const existing = map.getSource(POLYGONS_SOURCE) as mapboxgl.GeoJSONSource | undefined;
        if (existing) {
            existing.setData(polygonFC());
        } else {
            polygonSource ??= { spec: () => ({ type: "geojson", data: polygonFC() }) };
            installPolygons();
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

    function loadPolygonsByBbox(): void {
        // Half a step early, so geometry has usually landed by the time fills show.
        const loadTriggerZoom = POLYGON_STYLE.minZoom - 0.5;
        const maybeLoadView = () => {
            clearTimeout(debounceTimer);
            if (map.getZoom() < loadTriggerZoom) return;
            debounceTimer = setTimeout(() => void loadViewPolygons(), 250);
        };
        map.on("moveend", maybeLoadView);
        maybeLoadView();
    }

    function addPolygonTiles(polygonTiles: PolygonTiles): void {
        const { tiles, minzoom, maxzoom } = polygonTiles;
        firstTiles ??= polygonTiles;
        // A z/x/y with no tile resolves to the one empty tile, an empty 200 that mapbox draws as nothing and never logs.
        polygonSource = {
            spec: () => ({ type: "vector", tiles: [tiles], minzoom, maxzoom }),
            sourceLayer: TILE_LAYER,
            tiles: polygonTiles,
        };
        installPolygons();
    }

    const onPointClick = (feature: mapboxgl.MapboxGeoJSONFeature) => {
        const build = centroids?.build;
        if (!pinRef(build, feature.properties?.pin)) return;
        const coordinates = (feature.geometry as Point).coordinates.slice() as [number, number];
        void selectPolygon(build, feature.properties?.pin, coordinates);
    };

    function installPins(): void {
        if (!pins || !styleReady) return;
        addClusteredPins(map, { id: PINS_ID, data: pins, markerSvg: options.markerSvg, onPointClick });
    }

    function installPreview(): void {
        if (!previewReady || !styleReady || map.getSource(PREVIEW_SOURCE_ID)) return;
        map.addSource(PREVIEW_SOURCE_ID, { type: "geojson", data: preview });
        addPolygonLayers(map, PREVIEW_SOURCE_ID, PREVIEW_FILL_LAYER, PREVIEW_OUTLINE_LAYER);
    }

    map.on("styledataloading", () => {
        styleReady = false;
    });
    // Pins first, so the fills and the preview go in under the cluster glow.
    map.on("style.load", () => {
        styleReady = true;
        installPins();
        installPolygons();
        installPreview();
    });

    // Not behind the pins: a deep link at fill zoom should not wait on the pins body.
    void Promise.resolve(options.polygonTiles).then(
        (tiles) => {
            if (!isMapAlive(map)) return;
            if (tiles) addPolygonTiles(tiles);
            else loadPolygonsByBbox();
        },
        (err) => console.error("Error loading polygon tiles:", err),
    );

    try {
        centroids = (await options.centroids) ?? null;
    } catch (err) {
        console.error("Error loading land pins:", err);
    }
    if (!isMapAlive(map)) return;
    pins = pinsFromCentroids(centroids);
    installPins();
    if (typeof performance !== "undefined" && !performance.getEntriesByName(PINS_MARK).length) {
        performance.mark(PINS_MARK, { detail: { pins: pins.features.length } });
    }

    previewReady = true;
    installPreview();

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
            setPreview(emptyFC());
        });
    }
}
