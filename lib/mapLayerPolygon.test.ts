import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("mapbox-gl", () => ({ default: {} }));
vi.mock("./mapMarker", () => ({ addClusteredPins: vi.fn(), isMapAlive: () => true }));
vi.mock("./safeEase", () => ({ safeEase: vi.fn() }));

import { addMarkersLayer } from "./mapLayerPolygon";

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
            polygonTiles: Promise.resolve({
                tiles: "https://t.example/b1/polygons/{z}/{x}/{y}.pbf",
                minzoom: 7,
                maxzoom: 12,
            }),
        });
        await new Promise((r) => setTimeout(r, 300));

        const { setData: _, ...source } = map.sources.get("polygons") ?? {};
        expect(source).toEqual({
            type: "vector",
            tiles: ["https://t.example/b1/polygons/{z}/{x}/{y}.pbf"],
            minzoom: 7,
            maxzoom: 12,
        });
        expect(map.layers.get("polygons-fill")?.["source-layer"]).toBe("polygons");
        expect(map.layers.get("polygons-outline")?.["source-layer"]).toBe("polygons");
        expect(map.handlers.some(([type]) => type === "moveend")).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
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
