import { describe, expect, it } from "vitest";
import { goldBorderPath, goldBorderStroke } from "./goldBorder";

const points = (d: string) =>
	d
		.replace(/^M /, "")
		.replace(/ Z$/, "")
		.split(" L ")
		.map((p) => p.split(",").map(Number));

describe("goldBorderPath", () => {
	it("draws the art's outline when nothing needs clearing", () => {
		const p = points(goldBorderPath(1440, 820));
		expect(p[2][0]).toBeCloseTo(0.08069 * 1440, 0);
		expect(p[8][0]).toBeCloseTo(0.89238 * 1440, 0);
		expect(p[7][1]).toBeCloseTo(0.91792 * 820, 0);
	});

	it.each([
		[360, 660],
		[390, 764],
	])("clears a phone's fixed tool panel at %ix%i", (w, h) => {
		const panel = { left: 4, top: 0.12 * h, right: 58, bottom: 0.58 * h };
		const [p0, p1, p2] = points(goldBorderPath(w, h, { panel }));
		expect(p2[0]).toBeGreaterThan(panel.right);
		expect(p1[0]).toBeGreaterThan(panel.right);
		expect(p1[1]).toBeGreaterThan(panel.bottom);
		expect(p0[1]).toBeGreaterThan(p1[1]);
	});

	it.each([
		[390, 764, 68, 57],
		[1020, 620, 75, 52],
	])("steps the corner around the zoom readout and logo at %ix%i", (w, h, fromRight, fromBottom) => {
		const corner = { left: w - fromRight, top: h - fromBottom, right: w - 4, bottom: h - 4 };
		const p = points(goldBorderPath(w, h, { corner }));
		expect(p[6][1]).toBeLessThan(corner.top);
		expect(p[7][1]).toBeLessThan(corner.top);
		expect(p[8][0]).toBeLessThan(corner.left);
		expect(p[9][0]).toBeLessThan(corner.left);
		expect(p[7][0]).toBeGreaterThan(p[8][0]);
	});

	it("never shrinks a cutout that already clears its box", () => {
		const plain = points(goldBorderPath(1440, 820));
		const corner = { left: 1400, top: 790, right: 1430, bottom: 815 };
		expect(points(goldBorderPath(1440, 820, { corner }))).toEqual(plain);
	});
});

describe("goldBorderStroke", () => {
	it("keeps the art's weight on a large stage and a 2.5 px floor on a phone", () => {
		expect(goldBorderStroke(1436, 820)).toBeCloseTo(4.14, 1);
		expect(goldBorderStroke(390, 764)).toBe(2.5);
	});
});
