// Sticky priority layout: pass `previous` or borderline labels chatter every frame.

// Keep in sync with the .area-chip CSS in areaLabels.ts (font-size, max-width, padding).
const HANDLE_PX = 12;
const HANDLE_MAX_W = 170;
const CHIP_PAD_X = 9;
const BOX_PAD = 4;
const OVERLAP_SLOP = 4;
const DOT_BOX = 30;
const HYSTERESIS_PX2 = 900;

export type PrioMode = "both" | "big" | "recent";

export interface LabelArea {
	id: string;
	fullName: string;
	displayName?: string;
	hectares: number;
	/** Pass 0 for all when unknown; the score then orders purely by size. */
	visitedDaysAgo: number;
}

export interface LabelDecision {
	id: string;
	kind: "label" | "dot" | "hidden";
	x: number;
	y: number;
	text: string;
}

export interface LayoutOpts {
	prioMode?: PrioMode;
	selectedId?: string | null;
	collapseLosersToDot?: boolean;
	project: (area: LabelArea) => { x: number; y: number };
	measureText: (text: string, px: number) => number;
	/** Last pass's decision per id; omit on a cold pass. */
	previous?: ReadonlyMap<string, LabelDecision["kind"]>;
}

const FILLER = /^(blk|block|mini|pile|restor|restoration)$/i;
export function deriveHandle(fullName: string): string {
	// An auto-generated name is "<date><kind>_<user>": the kind word sits after the date.
	const s = String(fullName)
		.trim()
		.replace(/(^|\d)(polygon|line|point|track)[_\s-]*/i, "$1");
	const words = s.split(/[\s_]+/).filter((w) => w && !FILLER.test(w));
	const handle = words.slice(0, 2).join(" ");
	return handle || fullName;
}

interface Stats {
	maxHectares: number;
	minVisited: number;
	maxVisited: number;
}

export function score(area: LabelArea, mode: PrioMode, stats: Stats): number {
	const vSpan = stats.maxVisited - stats.minVisited || 1;
	const recency = (stats.maxVisited - area.visitedDaysAgo) / vSpan;
	const size = area.hectares / (stats.maxHectares || 1);
	if (mode === "big") return size;
	if (mode === "recent") return recency;
	return 0.5 * recency + 0.5 * size;
}

export type PlacedBox = { x0: number; y0: number; x1: number; y1: number };

function overlapArea(a: PlacedBox, b: PlacedBox): number {
	const ox = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
	const oy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
	return ox * oy;
}

export function collidesWithPlaced(
	box: PlacedBox,
	placed: PlacedBox[],
	slop: number = OVERLAP_SLOP,
): boolean {
	return placed.some((r) => overlapArea(box, r) > slop);
}

export interface LayoutResult {
	decisions: LabelDecision[];
	placed: PlacedBox[];
}

export function layoutLabels(
	areas: LabelArea[],
	opts: LayoutOpts,
): LayoutResult {
	const {
		prioMode = "both",
		selectedId = null,
		collapseLosersToDot = true,
		project,
		measureText,
		previous,
	} = opts;
	if (areas.length === 0) return { decisions: [], placed: [] };

	const stats: Stats = {
		maxHectares: Math.max(...areas.map((a) => a.hectares)),
		minVisited: Math.min(...areas.map((a) => a.visitedDaysAgo)),
		maxVisited: Math.max(...areas.map((a) => a.visitedDaysAgo)),
	};

	// Selected, then incumbents, then score, or the deadband can't hold a winner.
	const order = [...areas].sort((a, b) => {
		if (a.id === selectedId) return -1;
		if (b.id === selectedId) return 1;
		const aHeld = previous?.get(a.id) === "label" ? 1 : 0;
		const bHeld = previous?.get(b.id) === "label" ? 1 : 0;
		if (aHeld !== bHeld) return bHeld - aHeld;
		return score(b, prioMode, stats) - score(a, prioMode, stats);
	});

	const placed: PlacedBox[] = [];
	const decisions: LabelDecision[] = [];

	for (const area of order) {
		const { x, y } = project(area);
		const forced = area.id === selectedId;

		const text = area.displayName || deriveHandle(area.fullName);
		const w =
			Math.min(HANDLE_MAX_W, measureText(text, HANDLE_PX)) + CHIP_PAD_X * 2;
		const h = HANDLE_PX + 8;

		const box: PlacedBox = {
			x0: x - w / 2 - BOX_PAD,
			y0: y - h / 2 - BOX_PAD,
			x1: x + w / 2 + BOX_PAD,
			y1: y + h / 2 + BOX_PAD,
		};
		const held = previous?.get(area.id) === "label";
		const collides = collidesWithPlaced(
			box,
			placed,
			held ? HYSTERESIS_PX2 : OVERLAP_SLOP,
		);

		if (forced || !collides) {
			decisions.push({ id: area.id, kind: "label", x, y, text });
			placed.push(box);
		} else if (collapseLosersToDot) {
			decisions.push({ id: area.id, kind: "dot", x, y, text });
			placed.push({
				x0: x - DOT_BOX / 2,
				y0: y - DOT_BOX / 2,
				x1: x + DOT_BOX / 2,
				y1: y + DOT_BOX / 2,
			});
		} else {
			decisions.push({ id: area.id, kind: "hidden", x, y, text });
		}
	}

	return { decisions, placed };
}
