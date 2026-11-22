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
    const handlers: [string, Handler, string?][] = [];
    const emit = (type: string) => {
        for (const [t, h, layer] of handlers) if (t === type && !layer) h();
    };
    const map = {
        sources,
        layers,
        handlers,
        emit,
        /** What `setStyle` does: the old style's sources and layers go, then the new style loads. */
        switchBasemap() {
            sources.clear();
            layers.clear();
            emit("styledataloading");
            emit("style.load");
        },
        on: (type: string, a: unknown, b?: unknown) => {
            handlers.push(b ? [type, b as Handler, a as string] : [type, a as Handler]);
        },
        off: () => {},
        getZoom: () => 8,
        getBounds: () => ({ getWest: () => 30, getEast: () => 31, getSouth: () => -7, getNorth: () => -6 }),
        getSource: (id: string) => sources.get(id),
        addSource: (id: string, spec: Record<string, unknown>) => {
            sources.set(id, { ...spec, setData: vi.fn() });
        },
        getLayer: (id: string) => layers.get(id),
        removeLayer: (id: string) => {
            layers.delete(id);
        },
        removeSource: (id: string) => {
            sources.delete(id);
        },
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
    ])("draws no fills and asks nothing when the tiles are %s", async (_, polygonTiles) => {
        const map = fakeMap();
        await addMarkersLayer(map as never, {
            polygonsUrl: "/api/where/polygons",
            centroids: Promise.resolve(null),
            polygonTiles,
        });
        await new Promise((r) => setTimeout(r, 300));
        await flush();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(map.sources.has("polygons")).toBe(false);
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

describe("addMarkersLayer — a page holding a build the store pruned takes the live one", () => {
    const HELD = "20261112T140543Z-8d6d4c6e";
    const LIVE = "20261119T054546Z-b81be8f6";
    const SINCE = "20261115T101010Z-0a0a0a0a";
    const answer = { type: "Feature", geometry: null, properties: { landKey: "l1", landName: "A land" } };
    const pinUrl = (build: string, n: number) => `/api/where/polygons?pin=${encodeURIComponent(`${build}/${n}`)}`;
    // The live build numbers the same two places the other way round, and adds one.
    const LIVE_PINS = { build: LIVE, lonlat: [36, -7, 35, -6, 40, 1], large: [1, 0, 0] };
    const LIVE_INDEX = { build: LIVE, since: [SINCE, LIVE], tiles: { "9/306/263": 0, "9/307/263": 1 } };
    const tileAt = `${ROOT}/polygons/9/306/263.pbf`;
    let fetchMock: ReturnType<typeof vi.fn>;
    let answers: Record<string, () => Response>;

    beforeEach(() => {
        answers = {
            [`${ROOT}/builds/latest.json`]: () => Response.json({ build: LIVE, minzoom: 6, maxzoom: 11, pins: 3 }),
            [`${ROOT}/builds/${LIVE}/pins.json`]: () => Response.json(LIVE_PINS),
            [`${ROOT}/builds/${LIVE}/index.json`]: () => Response.json(LIVE_INDEX),
            [pinUrl(LIVE, 0)]: () => Response.json(answer),
            [pinUrl(LIVE, 1)]: () => Response.json(answer),
        };
        // Any pin of the held build: the store no longer has its list.
        fetchMock = vi.fn(async (url: string) => answers[String(url)]?.() ?? new Response(null, { status: String(url).includes(encodeURIComponent(HELD)) ? 204 : 404 }));
        vi.stubGlobal("fetch", fetchMock);
        vi.mocked(addClusteredPins).mockClear();
    });
    afterEach(() => vi.unstubAllGlobals());

    const asked = () => fetchMock.mock.calls.map(([u]) => String(u));
    const states = (selected: Record<string, unknown>[]) =>
        selected.map((s) => ("failed" in s ? "failed" : "loading" in s ? "loading" : "land"));

    async function stalePage(fillProps: Record<string, unknown> | null = null) {
        const selected: Record<string, unknown>[] = [];
        const map = { ...fakeMap(), queryRenderedFeatures: () => (fillProps ? [{ properties: fillProps }] : []) };
        const { polygonTiles, transformRequest } = polygonTileRequests(Promise.resolve({ ...TILES, build: HELD, tileUrl: rewrite }));
        await addMarkersLayer(map as never, {
            polygonsUrl: "/api/where/polygons",
            centroids: Promise.resolve({ build: HELD, lonlat: [35, -6, 36, -7], large: [0, 1] }),
            polygonTiles,
            onFeatureSelect: (f) => selected.push(f as Record<string, unknown>),
        });
        await flush();
        const clickPin = (n: number, at: [number, number]) => {
            const { onPointClick } = vi.mocked(addClusteredPins).mock.calls.at(-1)?.[1] as { onPointClick: (f: unknown) => void };
            onPointClick({ geometry: { type: "Point", coordinates: at }, properties: { pin: n } });
        };
        const fillClick = map.handlers.find(([type, , layer]) => type === "click" && layer === "polygons-fill")?.[1];
        return { map, selected, transformRequest, clickPin, fillClick };
    }
    const settle = async () => {
        for (let i = 0; i < 8; i++) await flush();
    };

    it("a pin click reads the live build once, swaps the pins and the tiles, and asks again for the pin at that place", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const { map, selected, transformRequest, clickPin } = await stalePage();
        const handlers = map.handlers.length;
        clickPin(1, [36, -7]);
        await settle();

        expect(asked()).toEqual([
            pinUrl(HELD, 1),
            `${ROOT}/builds/latest.json`,
            `${ROOT}/builds/${LIVE}/pins.json`,
            `${ROOT}/builds/${LIVE}/index.json`,
            pinUrl(LIVE, 0),
        ]);
        expect(states(selected)).toEqual(["loading", "land"]);
        expect(selected.at(-1)).toEqual(answer.properties);
        expect(vi.mocked(addClusteredPins).mock.calls.at(-1)?.[1].data.features.map((f) => f.geometry.coordinates)).toEqual([[36, -7], [35, -6], [40, 1]]);
        const { setData: _, ...source } = map.sources.get("polygons") ?? {};
        expect(source).toEqual({ type: "vector", tiles: [TEMPLATE], minzoom: 6, maxzoom: 11 });
        expect(map.layers.has("polygons-fill")).toBe(true);
        expect(transformRequest(tileAt, "Tile").url).toBe(`${ROOT}/polygons/9/306/263/${SINCE}.pbf`);
        expect(transformRequest(`${ROOT}/polygons/9/1/1.pbf`, "Tile").url).toBe(`${ROOT}/polygons/empty.pbf`);
        expect(map.handlers.length).toBe(handlers);
        expect(error).not.toHaveBeenCalled();

        // Recovered: the next click is one request, in the live build.
        fetchMock.mockClear();
        clickPin(1, [35, -6]);
        await settle();
        expect(asked()).toEqual([pinUrl(LIVE, 1)]);
        error.mockRestore();
    });

    it("a fill click recovers through its pin's place in the held build", async () => {
        const { selected, fillClick } = await stalePage({ pin: 0 });
        fillClick?.({ point: { x: 1, y: 1 }, lngLat: { toArray: () => [35.01, -6.01] } });
        await settle();
        expect(asked().at(0)).toBe(pinUrl(HELD, 0));
        expect(asked().at(-1)).toBe(pinUrl(LIVE, 1));
        expect(asked()).toHaveLength(5);
        expect(states(selected)).toEqual(["loading", "land"]);

        // The next fill click names the live build, which the tiles now are.
        fetchMock.mockClear();
        fillClick?.({ point: { x: 1, y: 1 }, lngLat: { toArray: () => [35.01, -6.01] } });
        await settle();
        expect(asked()).toEqual([pinUrl(LIVE, 0)]);
    });

    it.each([
        ["the live build is gone too", () => (answers[pinUrl(LIVE, 0)] = () => new Response(null, { status: 204 })), 5],
        ["the store names the build the page already holds", () => (answers[`${ROOT}/builds/latest.json`] = () => Response.json({ build: HELD, minzoom: 7, maxzoom: 12, pins: 2 })), 2],
        ["the live build's pins do not read", () => (answers[`${ROOT}/builds/${LIVE}/pins.json`] = () => new Response("No such object.", { status: 404 })), 4],
        ["the live build has no pin at that place", () => (answers[`${ROOT}/builds/${LIVE}/pins.json`] = () => Response.json({ ...LIVE_PINS, lonlat: [1, 1, 35, -6, 40, 1] })), 4],
    ])("fails in the drawer once, with no further request, when %s", async (_, arrange, requests) => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        arrange();
        const { selected, clickPin } = await stalePage();
        clickPin(1, [36, -7]);
        await settle();
        await new Promise((r) => setTimeout(r, 50));

        expect(states(selected)).toEqual(["loading", "failed"]);
        expect(asked()).toHaveLength(requests);
        expect(error).toHaveBeenCalledTimes(1);
        error.mockRestore();
    });

    it("two clicks while the live build is being read share that one read", async () => {
        const { selected, clickPin } = await stalePage();
        clickPin(1, [36, -7]);
        clickPin(0, [35, -6]);
        await settle();
        expect(asked().filter((u) => u.endsWith("latest.json"))).toHaveLength(1);
        expect(asked()).toHaveLength(7);
        expect(states(selected).filter((s) => s === "land")).toHaveLength(2);
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

describe("addMarkersLayer — a basemap switch keeps the pins, fills and preview", () => {
    const PIN_BUILD = "20261112T140543Z-8d6d4c6e";
    const CENTROIDS = { build: PIN_BUILD, lonlat: [35, -6, 36, -7], large: [0, 1] };
    const OUR_LAYERS = ["polygons-fill", "polygons-outline", "large-polygon-preview-fill", "large-polygon-preview-outline"];
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.mocked(addClusteredPins).mockClear();
    });
    afterEach(() => vi.unstubAllGlobals());

    const handlerCount = (map: ReturnType<typeof fakeMap>) => map.handlers.length;

    it("re-adds them from memory on the next style.load, binds nothing twice, and fetches nothing", async () => {
        fetchMock = vi.fn(async () => new Response("{}"));
        vi.stubGlobal("fetch", fetchMock);
        const map = fakeMap();
        await addMarkersLayer(map as never, {
            polygonsUrl: "/api/where/polygons",
            centroids: Promise.resolve(CENTROIDS),
            polygonTiles: Promise.resolve({ ...TILES, build: PIN_BUILD, tileUrl: rewrite }),
        });
        await flush();
        const tileSource = map.sources.get("polygons");
        const handlers = handlerCount(map);
        const firstPins = vi.mocked(addClusteredPins).mock.calls[0][1];

        map.switchBasemap();
        map.switchBasemap();

        expect([...map.layers.keys()].sort()).toEqual([...OUR_LAYERS].sort());
        expect(map.sources.get("polygons")).toEqual({ ...tileSource, setData: expect.any(Function) });
        expect(map.sources.has("large-polygon-preview")).toBe(true);
        const pinCalls = vi.mocked(addClusteredPins).mock.calls;
        expect(pinCalls).toHaveLength(3);
        expect(pinCalls[2][1].data).toBe(firstPins.data);
        expect(pinCalls[2][1].onPointClick).toBe(firstPins.onPointClick);
        expect(handlerCount(map)).toBe(handlers);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("keeps the large land's preview drawn across the switch", async () => {
        const large = {
            type: "Feature",
            geometry: { type: "Polygon", coordinates: [[[35, -6], [36, -6], [36, -7], [35, -6]]] },
            properties: { landKey: "l1", isLargePolygon: true },
        };
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(large))));
        const map = fakeMap();
        await addMarkersLayer(map as never, {
            polygonsUrl: "/api/where/polygons",
            centroids: Promise.resolve(CENTROIDS),
            polygonTiles: Promise.resolve({ ...TILES, build: PIN_BUILD, tileUrl: rewrite }),
            onFeatureSelect: () => {},
        });
        const { onPointClick } = vi.mocked(addClusteredPins).mock.calls[0][1] as { onPointClick: (f: unknown) => void };
        onPointClick({ geometry: { type: "Point", coordinates: [36, -7] }, properties: { pin: 1 } });
        await flush();
        await flush();

        map.switchBasemap();

        expect(map.sources.get("large-polygon-preview")?.data).toEqual({ type: "FeatureCollection", features: [large] });
    });

    it("waits for the new style when the pins land mid-switch", async () => {
        vi.stubGlobal("fetch", vi.fn());
        let resolvePins!: (c: typeof CENTROIDS) => void;
        const map = fakeMap();
        const done = addMarkersLayer(map as never, {
            polygonsUrl: "/api/where/polygons",
            centroids: new Promise((r) => (resolvePins = r)),
            polygonTiles: Promise.resolve({ ...TILES, tileUrl: rewrite }),
        });
        await flush();

        map.emit("styledataloading");
        resolvePins(CENTROIDS);
        await done;
        expect(vi.mocked(addClusteredPins)).not.toHaveBeenCalled();
        expect(map.sources.has("large-polygon-preview")).toBe(false);

        map.emit("style.load");
        expect(vi.mocked(addClusteredPins)).toHaveBeenCalledTimes(1);
        expect(map.sources.has("large-polygon-preview")).toBe(true);
    });
});
