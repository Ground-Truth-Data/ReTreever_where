import { area, featureCollection, intersect } from "@turf/turf";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import type { ExpressionSpecification, Map as MapboxMap } from "mapbox-gl";

export type DrawIntent = "polygon" | "line" | "pin" | null;
export type Lnglat = [number, number];

const DRAW_SOURCE_IDS = ["draw-edges", "draw-vertices", "provisional-polygon"] as const;
const COMPLETED_SOURCE_ID = "completed-features";

const POLYGON_DRAW_MINZOOM = 10;
const POLYGON_FILL = "#e8a06a";
const POLYGON_OUTLINE = "#d97c33";

const POLYGON_COLOR_CYCLE: ReadonlyArray<{ fill: string; stroke: string }> = [
	{ fill: POLYGON_FILL, stroke: POLYGON_OUTLINE },
	{ fill: "#cf4444", stroke: "#b82222" },
	{ fill: "#8fd48a", stroke: "#3a9e4e" },
	{ fill: "#7db4ec", stroke: "#2f7fd1" },
	{ fill: "#9c92ea", stroke: "#5a4bc9" },
	{ fill: "#d386e8", stroke: "#a33bc9" },
];

const POLYGON_FILL_OPACITY = 0.18;
const STACKED_FILL_OPACITY = 0.1;

// A PAINT expression, never a filter: filter zoom expressions only evaluate
// at integer zooms (mapbox-gl-js#6236) and go stale between them.
const shapeOpacity = (full: ExpressionSpecification | number) =>
	["step", ["zoom"], 0, POLYGON_DRAW_MINZOOM, full] as unknown as ExpressionSpecification;

const IS_POLYGON: ExpressionSpecification = ["==", ["geometry-type"], "Polygon"];

type RingBbox = [number, number, number, number];

function outerRingBbox(poly: Polygon): RingBbox {
	const xs = (poly.coordinates[0] ?? []).map((c) => c[0]);
	const ys = (poly.coordinates[0] ?? []).map((c) => c[1]);
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function bboxesIntersect(a: RingBbox, b: RingBbox): boolean {
	return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

// intersect, not booleanOverlap: that flags merely-touching plots; the 1m² floor ignores slivers.
function polygonsShareArea(a: Feature<Polygon>, b: Feature<Polygon>): boolean {
	try {
		const clip = intersect(featureCollection<Polygon>([a, b]));
		return clip !== null && area(clip) > 1;
	} catch {
		return false;
	}
}

/** Polygons stacked on an earlier one each take the next colour; the first of a stack keeps the default. */
function assignOverlapColors(
	features: Feature[],
): Map<number, { fill: string; stroke: string }> {
	const out = new Map<number, { fill: string; stroke: string }>();
	// root = placed-index of this polygon's stack anchor (a root points at itself).
	const placed: { feat: Feature<Polygon>; bbox: RingBbox; root: number }[] = [];
	const stackSize = new Map<number, number>();
	features.forEach((feat, i) => {
		if (feat.geometry?.type !== "Polygon") return;
		const poly = feat as Feature<Polygon>;
		const bbox = outerRingBbox(poly.geometry);
		const prev = placed.find(
			(p) => bboxesIntersect(bbox, p.bbox) && polygonsShareArea(poly, p.feat),
		);
		if (!prev) {
			placed.push({ feat: poly, bbox, root: placed.length });
			return;
		}
		const n = stackSize.get(prev.root) ?? 0;
		stackSize.set(prev.root, n + 1);
		placed.push({ feat: poly, bbox, root: prev.root });
		// Slot 0 is the parent's; children walk slots 1..6.
		out.set(i, POLYGON_COLOR_CYCLE[1 + (n % (POLYGON_COLOR_CYCLE.length - 1))]);
	});
	return out;
}

function emptyFC(): FeatureCollection {
	return { type: "FeatureCollection", features: [] };
}

export function getAccentColor(fallback = "#b36940"): string {
	if (typeof document === "undefined") return fallback;
	return (
		getComputedStyle(document.documentElement)
			.getPropertyValue("--color-draw")
			.trim() || fallback
	);
}

export function setupDrawSourcesAndLayers(
	map: MapboxMap,
	accent: string,
	onPainted?: () => void,
): void {
	// In dev, rebuild so a paint edit here shows on hot reload; in prod re-adding would throw.
	if (map.getSource(COMPLETED_SOURCE_ID)) {
		if (!import.meta.env?.DEV) return;
		const ours = [COMPLETED_SOURCE_ID, ...DRAW_SOURCE_IDS] as string[];
		// Layers reference sources, so layers go first.
		for (const layer of map.getStyle?.()?.layers ?? []) {
			const src = (layer as { source?: string }).source;
			if (src && ours.includes(src) && map.getLayer(layer.id)) map.removeLayer(layer.id);
		}
		for (const id of ours) if (map.getSource(id)) map.removeSource(id);
	}

	const empty = emptyFC();
	for (const id of [...DRAW_SOURCE_IDS, COMPLETED_SOURCE_ID])
		map.addSource(id, { type: "geojson", data: empty });

	const round = { "line-cap": "round", "line-join": "round" } as const;
	map.addLayer({
		id: "draw-edges-halo",
		type: "line",
		source: "draw-edges",
		layout: round,
		paint: { "line-color": "#1a1a1a", "line-width": 6, "line-opacity": 0.55 },
	});
	map.addLayer({
		id: "draw-edges-line",
		type: "line",
		source: "draw-edges",
		layout: round,
		paint: { "line-color": accent, "line-width": 4 },
	});
	map.addLayer({
		id: "provisional-polygon-fill",
		type: "fill",
		source: "provisional-polygon",
		filter: ["==", "$type", "Polygon"],
		paint: { "fill-color": POLYGON_FILL, "fill-opacity": 0.35 },
	});
	map.addLayer({
		id: "provisional-polygon-closing-edge",
		type: "line",
		source: "provisional-polygon",
		filter: ["==", "$type", "LineString"],
		paint: {
			"line-color": POLYGON_OUTLINE,
			"line-width": 2.5,
			"line-dasharray": [6, 4],
		},
	});
	map.addLayer({
		id: "draw-vertices-halo",
		type: "circle",
		source: "draw-vertices",
		paint: { "circle-radius": 7, "circle-color": "#ffffff" },
	});
	map.addLayer({
		id: "draw-vertices-dot",
		type: "circle",
		source: "draw-vertices",
		paint: { "circle-radius": 4, "circle-color": accent },
	});

	map.addLayer({
		id: "completed-fill",
		type: "fill",
		source: COMPLETED_SOURCE_ID,
		filter: IS_POLYGON,
		paint: {
			"fill-color": ["coalesce", ["get", "_fillCol"], POLYGON_FILL],
			"fill-opacity": shapeOpacity(["coalesce", ["get", "_stackFillOp"], POLYGON_FILL_OPACITY]),
		},
	});
	map.addLayer({
		id: "completed-stroke-halo",
		type: "line",
		source: COMPLETED_SOURCE_ID,
		layout: round,
		paint: {
			"line-color": "#1a1a1a",
			"line-width": ["case", IS_POLYGON, 3.5, 4],
			"line-opacity": shapeOpacity(0.5),
		},
	});
	map.addLayer({
		id: "completed-stroke",
		type: "line",
		source: COMPLETED_SOURCE_ID,
		layout: round,
		paint: {
			"line-color": [
				"case",
				IS_POLYGON,
				["coalesce", ["get", "_strokeCol"], POLYGON_OUTLINE],
				accent,
			],
			"line-width": ["case", IS_POLYGON, 1.5, 2],
			"line-opacity": shapeOpacity(1),
		},
	});

	onPainted?.();
}

export function buildDrawEdgesFC(vertices: Lnglat[]): FeatureCollection {
	if (vertices.length < 2) return emptyFC();
	return featureCollection([
		{ type: "Feature", geometry: { type: "LineString", coordinates: vertices }, properties: {} },
	]);
}

export function buildDrawVerticesFC(vertices: Lnglat[]): FeatureCollection {
	return featureCollection(
		vertices.map((coord) => ({
			type: "Feature" as const,
			geometry: { type: "Point" as const, coordinates: coord },
			properties: {},
		})),
	);
}

export function buildProvisionalPolygonFC(vertices: Lnglat[]): FeatureCollection {
	if (vertices.length < 2) return emptyFC();
	const features: Feature[] = [
		{
			type: "Feature",
			geometry: { type: "LineString", coordinates: [vertices[vertices.length - 1], vertices[0]] },
			properties: {},
		},
	];
	if (vertices.length >= 3) {
		features.push({
			type: "Feature",
			geometry: { type: "Polygon", coordinates: [[...vertices, vertices[0]]] },
			properties: {},
		});
	}
	return featureCollection(features);
}

// Stamped onto FC copies, never stored features: colour re-derives on every rebuild.
export function buildCompletedFC(features: Feature[]): FeatureCollection {
	const overlapColors = assignOverlapColors(features);
	return featureCollection(
		features.flatMap((feat, i) => {
			if (feat.geometry?.type === "Point") return [];
			const c = overlapColors.get(i);
			return [
				{
					...feat,
					properties: {
						...(feat.properties ?? {}),
						...(c ? { _fillCol: c.fill, _strokeCol: c.stroke, _stackFillOp: STACKED_FILL_OPACITY } : {}),
					},
				},
			];
		}),
	);
}

export function clearInProgressSources(map: MapboxMap): void {
	for (const id of DRAW_SOURCE_IDS) {
		const src = map.getSource(id);
		if (src && "setData" in src) {
			(src as unknown as { setData: (d: FeatureCollection) => void }).setData(emptyFC());
		}
	}
}
