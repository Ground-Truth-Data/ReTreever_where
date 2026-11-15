import { describe, expect, it } from "vitest";
import { goldBorderPath, PHONE_PANEL } from "./goldBorder";

const points = (d: string) =>
	d
		.replace(/^M /, "")
		.replace(/ Z$/, "")
		.split(" L ")
		.map((p) => p.split(",").map(Number));

describe("goldBorderPath", () => {
	it.each([
		[360, 740],
		[390, 844],
		[430, 932],
	])("clears the phone tool panel at %ix%i", (w, h) => {
		const [p0, p1, p2] = points(goldBorderPath(w, h, true));
		const panelRight = PHONE_PANEL.left + PHONE_PANEL.width;
		const panelBottom = (PHONE_PANEL.topFrac + PHONE_PANEL.heightFrac) * h;
		expect(p2[0]).toBeGreaterThan(panelRight);
		expect(p1[0]).toBeGreaterThan(panelRight);
		expect(p1[1]).toBeGreaterThan(panelBottom);
		expect(p0[1]).toBeGreaterThan(p1[1]);
	});

	it("keeps the art's own cutout where the stage is wide enough", () => {
		const [, p1, p2] = points(goldBorderPath(1440, 820, false));
		expect(p2[0]).toBeCloseTo(0.08069 * 1440, 0);
		expect(p1[0]).toBeCloseTo(0.10125 * 1440, 0);
	});
});
