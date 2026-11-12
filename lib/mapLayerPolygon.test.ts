import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("mapbox-gl", () => ({ default: {} }));
vi.mock("./mapMarker", () => ({ addClusteredPins: vi.fn(), isMapAlive: () => true }));
import { addClusteredPins } from "./mapMarker";
vi.mock("./safeEase", () => ({ safeEase: vi.fn() }));
// ReTreever's paraglide output: absent in a bare clone, so the child's own `npm test` stubs it.
vi.mock("$parent/src/lib/paraglide/messages", () => ({ m: new Proxy({}, { get: (_, k) => () => String(k) }) }));
vi.mock("$parent/src/lib/paraglide/runtime", () => ({ getLocale: () => "en" }));

import { addMarkersLayer, polygonTileRequests } from "./mapLayerPolygon";

type Handler = (...args: unknown[]) => void;

function fakeMap() {
    const sources = new Map<string, Record<string, unknown>>();
    const layers = new Map<string, Record<string, unknown>>();
    const handlers: [string, Handler][] = [];
    const map = {
        sources,
        layers,
        handlers,
        on: (type: string, a: unknown, b?: unknown) => {
            handlers.push([type, (b ?? a) as Handler]);
        },
        off: () => {},
        getZoom: () => 8,
        getBounds: () => ({ getWest: () => 30, getEast: () => 31, getSouth: () => -7, getNorth: () => -6 }),
        getSource: (id: string) => sources.get(id),
        addSource: (id: string, spec: Record<string, unknown>) => {
            sources.set(id, { ...spec, setData: vi.fn() });
        },
        getLayer: (id: string) => layers.get(id),
        addLayer: (spec: Record<string, unknown>) => {
            layers.set(spec.id as string, spec);
        },
        queryRenderedFeatures: () => [],
        querySourceFeatures: () => [],
        getCanvas: () => ({ style: {} }),
    };
    return map;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const ROOT = "https://t.example/api/where/tiles";
const TEMPLATE = `${ROOT}/polygons/{z}/{x}/{y}.pbf`;
const TILES = { build: "B1", tiles: TEMPLATE, minzoom: 7, maxzoom: 12 };
/** A stand-in for the host's resolver: owns only its own template's URLs. */
const rewrite = (url: string) =>
    url.replace(/^(.*\/polygons\/\d+\/\d+\/\d+)\.pbf$/, "$1/B1.pbf");

describe("addMarkersLayer — where the fills come from", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(async () => new Response(JSON.stringify({ features: [] })));
        vi.stubGlobal("fetch", fetchMock);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("draws the tiles as a vector source and never asks ?bbox=", async () => {
        const map = fakeMap();
        await addMarkersLayer(map as never, {
            polygonsUrl: "/api/where/polygons",
            centroids: Promise.resolve(null),
            polygonTiles: Promise.resolve({ ...TILES, tileUrl: rewrite }),
        });
        await new Promise((r) => setTimeout(r, 300));

        const { setData: _, ...source } = map.sources.get("polygons") ?? {};
        expect(source).toEqual({
            type: "vector",
            tiles: [TEMPLATE],
            minzoom: 7,
            maxzoom: 12,
        });
        expect(map.layers.get("polygons-fill")?.["source-layer"]).toBe("polygons");
        expect(map.layers.get("polygons-outline")?.["source-layer"]).toBe("polygons");
        expect(map.handlers.some(([type]) => type === "moveend")).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("adds no fills and never asks ?bbox= when the tiles reject", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const map = fakeMap();
        await addMarkersLayer(map as never, {
            polygonsUrl: "/api/where/polygons",
            centroids: Promise.resolve(null),
            polygonTiles: Promise.reject(new Error("latest.json failed")),
        });
        await new Promise((r) => setTimeout(r, 300));

        expect(map.sources.has("polygons")).toBe(false);
        expect(map.handlers.some(([type]) => type === "moveend")).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledTimes(1);
        error.mockRestore();
    });

    it.each([
        ["null", Promise.resolve(null)],
        ["absent", undefined],
    ])("asks ?bbox= when the tiles are %s", async (_, polygonTiles) => {
        const map = fakeMap();
        await addMarkersLayer(map as never, {
            polygonsUrl: "/api/where/polygons",
            centroids: Promise.resolve(null),
            polygonTiles,
        });
        await new Promise((r) => setTimeout(r, 300));
        await flush();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0][0])).toMatch(/^\/api\/where\/polygons\?bbox=/);
        expect(map.sources.get("polygons")?.type).toBe("geojson");
        expect(map.layers.get("polygons-fill")?.["source-layer"]).toBeUndefined();
    });
});

describe("addMarkersLayer — a click asks for a pin by its number, never by a key", () => {
    const PIN_BUILD = "20261112T140543Z-8d6d4c6e";
    let fetchMock: ReturnType<typeof vi.fn>;
    const answer = { type: "Feature", geometry: null, properties: { landKey: "l1", landName: "A land" } };

    beforeEach(() => {
        fetchMock = vi.fn(async () => new Response(JSON.stringify(answer)));
        vi.stubGlobal("fetch", fetchMock);
        vi.mocked(addClusteredPins).mockClear();
    });
    afterEach(() => vi.unstubAllGlobals());

    async function mapWith(fillProps: Record<string, unknown> | null) {
        const selected: Record<string, unknown>[] = [];
        const map = { ...fakeMap(), queryRenderedFeatures: () => (fillProps ? [{ properties: fillProps }] : []) };
        await addMarkersLayer(map as never, {
            polygonsUrl: "/api/where/polygons",
            centroids: Promise.resolve({ build: PIN_BUILD, lonlat: [35, -6, 36, -7], large: [0, 1] }),
            polygonTiles: Promise.resolve({ ...TILES, build: PIN_BUILD, tileUrl: rewrite }),
            onFeatureSelect: (f) => selected.push(f as Record<string, unknown>),
        });
        await flush();
        const fillClick = map.handlers.find(([type]) => type === "click")?.[1];
        return { map, selected, fillClick };
    }

    it("a pin click asks ?pin=<build>/<n>", async () => {
        const { selected } = await mapWith(null);
        const { onPointClick } = vi.mocked(addClusteredPins).mock.calls[0][1] as { onPointClick: (f: unknown) => void };
        onPointClick({ geometry: { type: "Point", coordinates: [36, -7] }, properties: { pin: 1 } });
        await flush();
        expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual([`/api/where/polygons?pin=${encodeURIComponent(`${PIN_BUILD}/1`)}`]);
        expect(selected.at(-1)).toEqual(answer.properties);
    });

    it("a fill click asks for the fill's pin in the tiles' build", async () => {
        const { fillClick, selected } = await mapWith({ pin: 7 });
        fillClick?.({ point: { x: 1, y: 1 }, lngLat: { toArray: () => [35, -6] } });
        await flush();
        expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual([`/api/where/polygons?pin=${encodeURIComponent(`${PIN_BUILD}/7`)}`]);
        expect(selected.at(-1)).toEqual(answer.properties);
    });

    it("a fill from a tile with no pin (one built before pins were numbered) fails quietly in the drawer and asks nothing", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const { fillClick, selected } = await mapWith({ polygonId: "c-some-key" });
        fillClick?.({ point: { x: 1, y: 1 }, lngLat: { toArray: () => [35, -6] } });
        await flush();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(selected.map((s) => ("failed" in s ? "failed" : "loading" in s ? "loading" : "other"))).toEqual(["loading", "failed"]);
        expect(error).not.toHaveBeenCalled();
        error.mockRestore();
    });
});

describe("polygonTileRequests — the map's transformRequest, filled before the source exists", () => {
    const tileAt = `${ROOT}/polygons/9/306/263.pbf`;

    function deferred<T>() {
        let resolve!: (v: T) => void;
        let reject!: (e: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    }

    it("passes tile URLs through until the tiles resolve, then rewrites them", async () => {
        const tiles = deferred<typeof TILES & { tileUrl: typeof rewrite }>();
        const { polygonTiles, transformRequest } = polygonTileRequests(tiles.promise);

        expect(transformRequest(tileAt, "Tile")).toEqual({ url: tileAt });
        tiles.resolve({ ...TILES, tileUrl: rewrite });
        await polygonTiles;
        expect(transformRequest(tileAt, "Tile")).toEqual({ url: `${ROOT}/polygons/9/306/263/B1.pbf` });
    });

    it("settles only once the rewrite is in place, so the source added on it never misses one", async () => {
        const tiles = deferred<typeof TILES & { tileUrl: typeof rewrite }>();
        const { polygonTiles, transformRequest } = polygonTileRequests(tiles.promise);
        const seen: string[] = [];
        void polygonTiles.then(() => seen.push(transformRequest(tileAt, "Tile").url));

        tiles.resolve({ ...TILES, tileUrl: rewrite });
        await polygonTiles;
        await flush();
        expect(seen).toEqual([`${ROOT}/polygons/9/306/263/B1.pbf`]);
    });

    it("hands addMarkersLayer the template, and the map's requests the rewrite", async () => {
        const { polygonTiles, transformRequest } = polygonTileRequests(
            Promise.resolve({ ...TILES, tileUrl: rewrite }),
        );
        const map = fakeMap();
        await addMarkersLayer(map as never, {
            polygonsUrl: "/api/where/polygons",
            centroids: Promise.resolve(null),
            polygonTiles,
        });
        await flush();

        expect(map.sources.get("polygons")?.tiles).toEqual([TEMPLATE]);
        expect(transformRequest(tileAt, "Tile").url).toBe(`${ROOT}/polygons/9/306/263/B1.pbf`);
    });

    it("leaves non-Tile requests and other tiles untouched", async () => {
        const { polygonTiles, transformRequest } = polygonTileRequests(
            Promise.resolve({ ...TILES, tileUrl: rewrite }),
        );
        await polygonTiles;

        expect(transformRequest(tileAt, "Source")).toEqual({ url: tileAt });
        expect(transformRequest(tileAt)).toEqual({ url: tileAt });
        const style = "https://api.mapbox.com/styles/v1/x/y?access_token=t";
        expect(transformRequest(style, "Style")).toEqual({ url: style });
        const satellite = "https://api.mapbox.com/v4/mapbox.satellite/9/306/263@2x.webp";
        expect(transformRequest(satellite, "Tile")).toEqual({ url: satellite });
    });

    it("defers to the caller's transformRequest, handing it the rewritten tile URL", async () => {
        const next = vi.fn((url: string) => ({ url, headers: { "x-from": "host" } }));
        const { polygonTiles, transformRequest } = polygonTileRequests(
            Promise.resolve({ ...TILES, tileUrl: rewrite }),
            next,
        );
        await polygonTiles;

        expect(transformRequest(tileAt, "Tile")).toEqual({
            url: `${ROOT}/polygons/9/306/263/B1.pbf`,
            headers: { "x-from": "host" },
        });
        expect(next).toHaveBeenLastCalledWith(`${ROOT}/polygons/9/306/263/B1.pbf`, "Tile");
        transformRequest("https://api.mapbox.com/fonts/v1/x", "Glyphs");
        expect(next).toHaveBeenLastCalledWith("https://api.mapbox.com/fonts/v1/x", "Glyphs");
    });

    it("null or rejected tiles leave every URL as it is, and the rejection still reaches the map", async () => {
        const none = polygonTileRequests(Promise.resolve(null));
        expect(await none.polygonTiles).toBeNull();
        expect(none.transformRequest(tileAt, "Tile")).toEqual({ url: tileAt });

        const failed = polygonTileRequests(Promise.reject(new Error("index.json answered 404")));
        await expect(failed.polygonTiles).rejects.toThrow("index.json answered 404");
        expect(failed.transformRequest(tileAt, "Tile")).toEqual({ url: tileAt });
    });
});
