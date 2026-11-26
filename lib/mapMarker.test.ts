import { describe, expect, it } from "vitest";
import { WAG_VARIANT_COUNT, wagClocks, wagFrameAt, wagVariantOf, withWagVariants } from "./mapMarker";

describe("wag variants", () => {
    it("a dog's variant depends only on its place", () => {
        const a = wagVariantOf([36.12345, -7.54321]);
        expect(wagVariantOf([36.12345, -7.54321])).toBe(a);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(WAG_VARIANT_COUNT);
    });

    it("spreads many dogs across every variant", () => {
        const seen = new Set<number>();
        for (let i = 0; i < 200; i++) seen.add(wagVariantOf([i * 0.37, -i * 0.11]));
        expect(seen.size).toBe(WAG_VARIANT_COUNT);
    });

    it("tags each point with its variant, and the same data tags the same", () => {
        const fc = {
            type: "FeatureCollection" as const,
            features: [10, 20, 30].map((x) => ({
                type: "Feature" as const,
                geometry: { type: "Point" as const, coordinates: [x, -x] },
                properties: { pin: x },
            })),
        };
        const once = withWagVariants(fc).features.map((f) => f.properties?.wag);
        const twice = withWagVariants(fc).features.map((f) => f.properties?.wag);
        expect(once).toEqual(twice);
        expect(withWagVariants(fc).features[0].properties?.pin).toBe(10);
        fc.features.forEach((f, i) => expect(once[i]).toBe(wagVariantOf(f.geometry.coordinates)));
    });

    it("clocks run slow to fast, from distinct start frames", () => {
        const base = 1000 / 24;
        const clocks = wagClocks(base, 96);
        expect(clocks).toHaveLength(WAG_VARIANT_COUNT);
        const speeds = clocks.map((c) => base / c.frameMs);
        expect(new Set(speeds).size).toBe(WAG_VARIANT_COUNT);
        expect(Math.min(...speeds)).toBeLessThanOrEqual(0.7);
        expect(Math.max(...speeds)).toBeGreaterThanOrEqual(1.4);
        const starts = clocks.map((c) => c.startFrame);
        expect(new Set(starts).size).toBe(WAG_VARIANT_COUNT);
        for (const s of starts) {
            expect(s).toBeGreaterThanOrEqual(0);
            expect(s).toBeLessThan(96);
        }
    });

    it("after two seconds the variants have wagged different distances", () => {
        const base = 1000 / 24;
        const clocks = wagClocks(base, 96);
        const advanced = clocks.map((c) => (wagFrameAt(c, 2000, 96) - c.startFrame + 96) % 96);
        expect(new Set(advanced).size).toBe(WAG_VARIANT_COUNT);
        expect(advanced).toEqual([...advanced].sort((a, b) => a - b));
    });
});
