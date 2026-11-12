import { describe, expect, it } from "vitest";
import { formatMapHash, parseMapHash } from "./mapUtilsHash";

describe("formatMapHash", () => {
	it("keeps zoom to one decimal and lat/lng to what the zoom can show", () => {
		expect(formatMapHash(4.23456, 12.34567, -45.67891)).toBe("#4.2/12.35/-45.68");
		expect(formatMapHash(7.5, 12.34567, -45.67891)).toBe("#7.5/12.346/-45.679");
		expect(formatMapHash(12.04, 35.681234, 139.765432)).toBe("#12/35.6812/139.7654");
		expect(formatMapHash(14.23, 35.681234, 139.765432)).toBe("#14.2/35.68123/139.76543");
	});

	it("writes no padding zeros and no negative zero", () => {
		expect(formatMapHash(3, 10.1, -0.001)).toBe("#3/10.1/0");
	});

	it("round-trips through parseMapHash", () => {
		expect(parseMapHash(formatMapHash(7.5, 12.34567, -45.67891))).toEqual({ zoom: 7.5, center: [-45.679, 12.346] });
	});
});

describe("parseMapHash", () => {
	it("still reads an old five-decimal hash", () => {
		expect(parseMapHash("#14.23/35.68123/139.76543")).toEqual({ zoom: 14.23, center: [139.76543, 35.68123] });
	});

	it("is null for anything else", () => {
		expect(parseMapHash("")).toBeNull();
		expect(parseMapHash("#4/12")).toBeNull();
		expect(parseMapHash("#a/b/c")).toBeNull();
	});
});
