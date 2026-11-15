/**
 * The gold border's outline as fractions of the stage, traced from whereAssets/gold-border.svg: the left cutout
 * (points 1–2) frames the tool panel, the bottom-right step clears the zoom readout.
 */
const OUTLINE: readonly [number, number][] = [
	[0.00144, 0.58852],
	[0.10125, 0.54238],
	[0.08069, 0.05744],
	[0.00168, 0.02366],
	[0.00153, 0.00281],
	[0.99804, 0.00337],
	[0.99856, 0.91754],
	[0.91170, 0.91792],
	[0.89238, 0.93641],
	[0.89268, 0.99682],
	[0.00198, 0.99721],
];

/** The phone tool panel's box in px, kept equal to WherePage.svelte's `@media (max-width: 767px) .tool-panel`. */
export const PHONE_PANEL = { left: 4, width: 54, topFrac: 0.12, heightFrac: 0.46 } as const;
const GAP = 6;
const SLANT = 8;

/**
 * The outline in px for a stage of w × h. On a phone the panel is fixed px while the art's cutout is a share of the
 * width, so the cutout is widened and lowered until it clears the panel by GAP, keeping the art's slant.
 */
export function goldBorderPath(w: number, h: number, phone: boolean): string {
	const pts = OUTLINE.map(([fx, fy]) => [fx * w, fy * h]);
	if (phone) {
		const right = PHONE_PANEL.left + PHONE_PANEL.width + GAP;
		const bottom = (PHONE_PANEL.topFrac + PHONE_PANEL.heightFrac) * h + GAP;
		const drop = pts[0][1] - pts[1][1];
		pts[2][0] = Math.max(pts[2][0], right);
		pts[1][0] = Math.max(pts[1][0], right + SLANT);
		pts[1][1] = Math.max(pts[1][1], bottom);
		pts[0][1] = Math.max(pts[0][1], pts[1][1] + drop);
	}
	return `M ${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L ")} Z`;
}
