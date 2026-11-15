/**
 * The gold border's outline as fractions of the stage, from the designer's art: the left cutout (points 1–2)
 * frames the tool panel, the bottom-right step (points 6–9) frames the zoom readout and the mapbox logo.
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
/** The art's size and stroke, so the px stroke keeps the weight the stretched art had. */
const ART_W = 1009.86;
const ART_H = 517.715;
const ART_STROKE = 2.91;
const GAP = 6;

/** A box in stage px. */
export type Box = { left: number; top: number; right: number; bottom: number };

/** Boxes the line must not cross: the tool panel (only where it is fixed px, on a phone) and the corner controls. */
export type Clear = { panel?: Box | null; corner?: Box | null };

/**
 * The outline in px for a stage of w × h. The art's cutouts are shares of the stage while what they frame is fixed
 * px, so each cutout grows, never shrinks, until it clears its box by GAP, keeping the art's slants.
 */
export function goldBorderPath(w: number, h: number, clear: Clear = {}): string {
	const pts = OUTLINE.map(([fx, fy]) => [fx * w, fy * h]);
	const { panel, corner } = clear;
	if (panel) {
		const slant = pts[1][0] - pts[2][0];
		const drop = pts[0][1] - pts[1][1];
		pts[2][0] = Math.max(pts[2][0], panel.right + GAP);
		pts[1][0] = Math.max(pts[1][0], pts[2][0] + slant);
		pts[1][1] = Math.max(pts[1][1], panel.bottom + GAP);
		pts[0][1] = Math.max(pts[0][1], pts[1][1] + drop);
	}
	if (corner) {
		const up = Math.max(0, pts[7][1] - (corner.top - GAP));
		const out = Math.max(0, pts[8][0] - (corner.left - GAP));
		for (const i of [6, 7, 8]) pts[i][1] -= up;
		for (const i of [7, 8, 9]) pts[i][0] -= out;
	}
	return `M ${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L ")} Z`;
}

/** The stroke the stretched art drew at this size, never thinner than 2.5 px. */
export function goldBorderStroke(w: number, h: number): number {
	return Math.max(2.5, ART_STROKE * Math.min(w / ART_W, h / ART_H));
}
