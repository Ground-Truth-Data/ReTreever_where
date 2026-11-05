import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("mapbox-gl", () => ({ default: {} }));
vi.mock("./mapMarker", () => ({ addClusteredPins: vi.fn(), isMapAlive: () => true }));
vi.mock("./safeEase", () => ({ safeEase: vi.fn() }));

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
const TILES = { tiles: TEMPLATE, minzoom: 7, maxzoom: 12 };
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
