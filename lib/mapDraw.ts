import { area, featureCollection, intersect } from "@turf/turf";
import type {
	Feature,
	FeatureCollection,
	LineString,
	MultiPolygon,
	Point,
	Polygon,
} from "geojson";
import type {
	ExpressionSpecification,
	FilterSpecification,
	GeoJSONSource,
	Map as MapboxMap,
} from "mapbox-gl";
import { glyphStack } from "./glyphStack";
import { deriveHandle } from "./labelPlacement";
import { newId } from "./newId";
import { safeEaseTo, safeFitBounds } from "./safeMap";

export type DrawIntent = "polygon" | "line" | "pin" | null;
export type Lnglat = [number, number];

const DRAW_SOURCE_IDS = [
	"draw-edges",
	"draw-vertices",
	"provisional-polygon",
] as const;
const COMPLETED_SOURCE_ID = "completed-features";

// A cluster split re-averages the pin and reads as flight; hand off before splits get big.
export const BOUNDARY_PIN_MAXZOOM = 12;
export const SHAPE_DRAW_MINZOOM = 14;
export const POLYGON_DRAW_MINZOOM = 10;
// PAINT ORDER: block last so it wins the overlap.
export const CENTROID_KINDS = ["polygon", "block"] as const;
export type CentroidKind = (typeof CENTROID_KINDS)[number];
const centroidSourceId = (k: CentroidKind) => `completed-centroids-${k}`;
const CENTROID_PIN_LAYERS = CENTROID_KINDS.map(
	(k) => `${centroidSourceId(k)}-pin`,
);

const POLYGON_FILL = "#e8a06a";
export const POLYGON_OUTLINE = "#d97c33";
// POLYGON_COLOR_CYCLE omits gold so no ordinary polygon wears the block's signature.
export const BLOCK_GOLD = "#ffd700";
const TRACK_GOLD = BLOCK_GOLD;

export const POLYGON_COLOR_CYCLE: ReadonlyArray<{
	fill: string;
	stroke: string;
}> = [
	{ fill: POLYGON_FILL, stroke: POLYGON_OUTLINE },
	{ fill: "#cf4444", stroke: "#b82222" },
	{ fill: "#8fd48a", stroke: "#3a9e4e" },
	{ fill: "#7db4ec", stroke: "#2f7fd1" },
	{ fill: "#9c92ea", stroke: "#5a4bc9" },
	{ fill: "#d386e8", stroke: "#a33bc9" },
];

export function isBlockFeature(feat: Feature): boolean {
	const gt = feat.geometry?.type;
	if (gt !== "Polygon" && gt !== "MultiPolygon") return false;
	const v = feat.properties?.blockNumber;
	return typeof v === "string" && v.trim() !== "";
}

const IS_BLOCK: ExpressionSpecification = ["==", ["get", "_isBlock"], true];

const IS_BLOCK_VERTEX: ExpressionSpecification = [
	"==",
	["get", "_parentIsBlock"],
	true,
];

const IS_BLOCK_OR_ITS_VERTEX: ExpressionSpecification = [
	"any",
	IS_BLOCK,
	IS_BLOCK_VERTEX,
];

// A PAINT expression, never a filter: filter zoom expressions only evaluate
// at integer zooms (mapbox-gl-js#6236) and go stale between them.
const shapeOpacity = (
	full: ExpressionSpecification | number,
): ExpressionSpecification =>
	[
		"step",
		["zoom"],
		0,
		POLYGON_DRAW_MINZOOM,
		["case", IS_BLOCK_OR_ITS_VERTEX, 0, full],
		SHAPE_DRAW_MINZOOM,
		full,
	] as unknown as ExpressionSpecification;

const HAS_CENTROID: ExpressionSpecification = [
	"any",
	["has", "point_count"],
	["has", "_bbox"],
];
const IS_REAL_CLUSTER: ExpressionSpecification = [
	">",
	["coalesce", ["get", "point_count"], 0],
	1,
];

export const STROKE = {
	block: { line: 5, casing: 9 },
	polygon: { line: 1.5, casing: 3.5 },
	line: { line: 2, casing: 4 },
	track: { line: 1.5, casing: 3, gap: 3, casingGap: 1.5 },
} as const;

// Blocks interpolate across zoom because their nodes are visible at rest at every scale.
export const NODE = {
	block: {
		disc: [
			[10, 4],
			[14, 7],
			[17, 10],
		],
		pupil: [
			[10, 1.3],
			[14, 2.3],
			[17, 3.2],
		],
		ring: 1.5,
	},
	handle: { disc: 5.5, pupil: 3 },
	// No disc: a white ring on every GPS fix is clutter.
	trackDot: 5.5,
} as const;

// `["zoom"]` is legal only as the outermost interpolate/step input, so a per-vertex `case` goes inside each stop via `atStop`.
function zoomRamp(
	stops: ReadonlyArray<readonly [number, number]>,
	atStop: (value: number) => ExpressionSpecification | number = (v) => v,
) {
	return [
		"interpolate",
		["linear"],
		["zoom"],
		...stops.flatMap(([z, v]) => [z, atStop(v)]),
	] as unknown as ExpressionSpecification;
}

export type RingBbox = [number, number, number, number];

function outerRingBbox(poly: Polygon): RingBbox {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const [x, y] of poly.coordinates[0] ?? []) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	return [minX, minY, maxX, maxY];
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

export function assignOverlapColors(
	features: Feature[],
): Map<number, { fill: string; stroke: string }> {
	const out = new Map<number, { fill: string; stroke: string }>();
	const placed: {
		feat: Feature<Polygon>;
		bbox: RingBbox;
		// placed-index of this polygon's stack anchor (a root points at itself).
		root: number;
	}[] = [];
	const stackSize = new Map<number, number>();
	for (let i = 0; i < features.length; i++) {
		const feat = features[i];
		if (feat.geometry?.type !== "Polygon") continue;
		// A block is gold regardless, so it takes no slot.
		if (isBlockFeature(feat)) continue;
		const poly = feat as Feature<Polygon>;
		const bbox = outerRingBbox(poly.geometry);
		let root = -1;
		for (let p = 0; p < placed.length; p++) {
			const prev = placed[p];
			if (!bboxesIntersect(bbox, prev.bbox)) continue;
			if (polygonsShareArea(poly, prev.feat)) {
				root = prev.root;
				break;
			}
		}
		if (root === -1) {
			placed.push({ feat: poly, bbox, root: placed.length });
			continue;
		}
		const n = stackSize.get(root) ?? 0;
		stackSize.set(root, n + 1);
		// Slot 0 is the parent's; children walk slots 1..6.
		const color = 1 + (n % (POLYGON_COLOR_CYCLE.length - 1));
		placed.push({ feat: poly, bbox, root });
		out.set(i, POLYGON_COLOR_CYCLE[color]);
	}
	return out;
}

export const POLYGON_FILL_OPACITY_DEFAULT = 0.18;

const STACKED_FILL_OPACITY = 0.1;

// to-number guards string values surviving a KML round-trip.
const POLYGON_FILL_OPACITY_EXPR: ExpressionSpecification = [
	"case",
	["has", "fillOpacity"],
	["to-number", ["get", "fillOpacity"], POLYGON_FILL_OPACITY_DEFAULT],
	["has", "_stackFillOp"],
	["to-number", ["get", "_stackFillOp"], POLYGON_FILL_OPACITY_DEFAULT],
	POLYGON_FILL_OPACITY_DEFAULT,
];

// Module-level: a post-setStyle layer rebuild must reapply the current slider value.
let polygonFillFactor = 1;

function polygonFillOpacityExpr(): ExpressionSpecification {
	if (polygonFillFactor === 1) return POLYGON_FILL_OPACITY_EXPR;
	return ["min", 1, ["*", polygonFillFactor, POLYGON_FILL_OPACITY_EXPR]];
}

export function applyPolygonFillOpacity(map: MapboxMap, factor: number): void {
	polygonFillFactor = Math.max(0, Math.min(2, factor));
	if (map.getLayer("completed-fill")) {
		map.setPaintProperty(
			"completed-fill",
			"fill-opacity",
			polygonFillOpacityExpr(),
		);
	}
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

const VERTEX_HANDLE_LAYERS = [
	"completed-vertices-halo",
	"completed-vertices-dot",
] as const;

const VERTEX_HANDLES_HIDDEN: FilterSpecification = [
	"all",
	["==", ["geometry-type"], "Point"],
	["any", IS_BLOCK_VERTEX, ["==", ["get", "_idx"], -1]],
];

// DEV ONLY. Layers reference sources, so layers go first.
function teardownDrawLayers(map: MapboxMap): void {
	const style = map.getStyle?.();
	for (const layer of style?.layers ?? []) {
		const src = (layer as { source?: string }).source;
		if (
			src === COMPLETED_SOURCE_ID ||
			(typeof src === "string" &&
				(src.startsWith("completed-centroids-") ||
					DRAW_SOURCE_IDS.includes(src as (typeof DRAW_SOURCE_IDS)[number])))
		) {
			if (map.getLayer(layer.id)) map.removeLayer(layer.id);
		}
	}
	for (const id of [
		COMPLETED_SOURCE_ID,
		...CENTROID_KINDS.map(centroidSourceId),
		...DRAW_SOURCE_IDS,
	]) {
		if (map.getSource(id)) map.removeSource(id);
	}
}

export function setupDrawSourcesAndLayers(
	map: MapboxMap,
	accent: string,
	// `false` on a host that draws geometry elsewhere (mobile's SnakeRuler).
	withInProgress = true,
	onPainted?: () => void,
): void {
	// In dev, rebuild so a paint edit here shows on hot reload; in prod re-adding would throw.
	if (map.getSource(COMPLETED_SOURCE_ID)) {
		if (!import.meta.env?.DEV) return;
		teardownDrawLayers(map);
	}

	const empty = emptyFC();

	if (withInProgress) {
		map.addSource("draw-edges", { type: "geojson", data: empty });
		map.addSource("draw-vertices", { type: "geojson", data: empty });
		map.addSource("provisional-polygon", { type: "geojson", data: empty });

		map.addLayer({
			id: "draw-edges-halo",
			type: "line",
			source: "draw-edges",
			layout: { "line-cap": "round", "line-join": "round" },
			paint: {
				"line-color": "#1a1a1a",
				"line-width": 6,
				"line-opacity": 0.55,
			},
		});
		map.addLayer({
			id: "draw-edges-line",
			type: "line",
			source: "draw-edges",
			layout: { "line-cap": "round", "line-join": "round" },
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
	}

	map.addSource(COMPLETED_SOURCE_ID, { type: "geojson", data: empty });

	map.addLayer({
		id: "completed-fill",
		type: "fill",
		source: COMPLETED_SOURCE_ID,
		filter: ["==", ["geometry-type"], "Polygon"],
		paint: {
			"fill-color": [
				"case",
				IS_BLOCK,
				BLOCK_GOLD,
				["coalesce", ["get", "_fillCol"], POLYGON_FILL],
			],
			// A block is unshaded: you work inside it, so the ground must stay readable.
			"fill-opacity": shapeOpacity(["case", IS_BLOCK, 0, polygonFillOpacityExpr()]),
		},
	});
	// Area-name labels are DOM markers: GL text can't do the font/halo/wrap.
	map.addLayer({
		id: "completed-stroke-halo",
		type: "line",
		source: COMPLETED_SOURCE_ID,
		layout: { "line-cap": "round", "line-join": "round" },
		paint: {
			"line-color": ["case", IS_BLOCK, "rgba(14,16,8,0.55)", "#1a1a1a"],
			"line-width": [
				"case",
				["==", ["get", "featureType"], "track"],
				STROKE.track.casing,
				IS_BLOCK,
				STROKE.block.casing,
				["==", ["geometry-type"], "Polygon"],
				STROKE.polygon.casing,
				STROKE.line.casing,
			],
			"line-gap-width": [
				"case",
				["==", ["get", "featureType"], "track"],
				STROKE.track.casingGap,
				0,
			],
			"line-opacity": shapeOpacity(0.5),
		},
	});
	map.addLayer({
		id: "completed-stroke",
		type: "line",
		source: COMPLETED_SOURCE_ID,
		layout: { "line-cap": "round", "line-join": "round" },
		paint: {
			"line-color": [
				"case",
				["==", ["get", "featureType"], "track"],
				TRACK_GOLD,
				IS_BLOCK,
				BLOCK_GOLD,
				["==", ["geometry-type"], "Polygon"],
				["coalesce", ["get", "_strokeCol"], POLYGON_OUTLINE],
				accent,
			],
			"line-width": [
				"case",
				["==", ["get", "featureType"], "track"],
				STROKE.track.line,
				IS_BLOCK,
				STROKE.block.line,
				["==", ["geometry-type"], "Polygon"],
				STROKE.polygon.line,
				STROKE.line.line,
			],
			"line-gap-width": [
				"case",
				["==", ["get", "featureType"], "track"],
				STROKE.track.gap,
				0,
			],
			"line-opacity": shapeOpacity(["case", IS_BLOCK, 0.78, 1]),
		},
	});
	map.addLayer({
		id: "completed-track-ties",
		type: "line",
		source: COMPLETED_SOURCE_ID,
		filter: [
			"all",
			["==", ["get", "featureType"], "track"],
			["==", ["geometry-type"], "LineString"],
		],
		layout: { "line-cap": "butt", "line-join": "round" },
		paint: {
			"line-color": TRACK_GOLD,
			"line-width": 9,
			"line-dasharray": [0.12, 1.6],
		},
	});
	map.addLayer({
		id: "completed-vertices-halo",
		type: "circle",
		source: COMPLETED_SOURCE_ID,
		filter: VERTEX_HANDLES_HIDDEN,
		paint: {
			"circle-radius": zoomRamp(NODE.block.disc, (blockR) => [
				"case",
				["==", ["get", "_isTrack"], true],
				0,
				IS_BLOCK_VERTEX,
				blockR,
				NODE.handle.disc,
			]),
			"circle-color": ["case", IS_BLOCK_VERTEX, BLOCK_GOLD, "#ffffff"],
			"circle-opacity": shapeOpacity(1),
			"circle-stroke-opacity": shapeOpacity(1),
			"circle-stroke-color": "rgba(14,16,8,0.55)",
			"circle-stroke-width": [
				"case",
				IS_BLOCK_VERTEX,
				NODE.block.ring,
				0,
			],
		},
	});
	map.addLayer({
		id: "completed-vertices-dot",
		type: "circle",
		source: COMPLETED_SOURCE_ID,
		filter: VERTEX_HANDLES_HIDDEN,
		paint: {
			"circle-radius": zoomRamp(NODE.block.pupil, (blockR) => [
				"case",
				["==", ["get", "_isTrack"], true],
				NODE.trackDot,
				IS_BLOCK_VERTEX,
				blockR,
				NODE.handle.pupil,
			]),
			"circle-color": [
				"case",
				["==", ["get", "_isTrack"], true],
				TRACK_GOLD,
				IS_BLOCK_VERTEX,
				"rgba(14,16,8,0.85)",
				["==", ["get", "_parentType"], "Polygon"],
				["coalesce", ["get", "_strokeCol"], POLYGON_OUTLINE],
				accent,
			],
			"circle-opacity": shapeOpacity(1),
		},
	});

	for (const kind of CENTROID_KINDS) {
		const isBlock = kind === "block";
		const disc = isBlock ? BLOCK_GOLD : POLYGON_OUTLINE;
		const ring = isBlock ? "rgba(14,16,8,0.55)" : "#ffffff";
		const ringW = isBlock ? NODE.block.ring : 2;
		const src = centroidSourceId(kind);

		map.addSource(src, {
			type: "geojson",
			data: empty,
			cluster: true,
			clusterMaxZoom: BOUNDARY_PIN_MAXZOOM,
			// Widen only with a split transition: the pin's jump on a split scales with this.
			clusterRadius: 45,
			// The default 2 emits a bare leaf for a solitary shape — a second shape to draw.
			clusterMinPoints: 1,
		});
		map.addLayer({
			id: `${src}-pin`,
			type: "circle",
			source: src,
			filter: HAS_CENTROID,
			maxzoom: isBlock ? SHAPE_DRAW_MINZOOM : POLYGON_DRAW_MINZOOM,
			paint: {
				"circle-color": disc,
				"circle-radius": isBlock ? 9 : 7,
				"circle-stroke-width": ringW,
				"circle-stroke-color": ring,
			},
		});
		if (isBlock) {
			map.addLayer({
				id: `${src}-pupil`,
				type: "circle",
				source: src,
				filter: HAS_CENTROID,
				maxzoom: isBlock ? SHAPE_DRAW_MINZOOM : POLYGON_DRAW_MINZOOM,
				paint: {
					"circle-color": "rgba(14,16,8,0.85)",
					"circle-radius": 4,
				},
			});
		}
	}

	// Counts in their own pass: inside the kind loop the next kind's pin buries them.
	for (const kind of CENTROID_KINDS) {
		const isBlock = kind === "block";
		const src = centroidSourceId(kind);
		map.addLayer({
			id: `${src}-count`,
			type: "symbol",
			source: src,
			filter: IS_REAL_CLUSTER,
			maxzoom: isBlock ? SHAPE_DRAW_MINZOOM : POLYGON_DRAW_MINZOOM,
			layout: {
				"text-field": ["get", "point_count_abbreviated"],
				"text-font": glyphStack(map),
				"text-size": 13,
				// Beside the pin, never over the donut hole: a polygon is often drawn on a block.
				"text-anchor": isBlock ? "left" : "right",
				"text-offset": isBlock ? [0.5, -0.75] : [-0.5, -0.75],
				"text-allow-overlap": true,
				"text-ignore-placement": true,
			},
			paint: {
				"text-color": "#000000",
				"text-halo-color": "#ffffff",
				"text-halo-width": 1.8,
			},
		});
	}

	onPainted?.();
}

export function setVertexHandlesForFeature(
	map: MapboxMap,
	idx: number | null,
): void {
	// Block nodes ride through both branches: selecting another shape must not strip them.
	const filter: FilterSpecification =
		idx === null
			? VERTEX_HANDLES_HIDDEN
			: [
				  "all",
				  ["==", ["geometry-type"], "Point"],
				  ["any", IS_BLOCK_VERTEX, ["==", ["get", "_idx"], idx]],
			  ];
	for (const id of VERTEX_HANDLE_LAYERS) {
		if (map.getLayer(id)) map.setFilter(id, filter);
	}
}

export function geometryBbox(g: Polygon | MultiPolygon): RingBbox | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
	for (const poly of polys) {
		for (const [x, y] of poly[0] ?? []) {
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}
	if (!Number.isFinite(minX)) return null;
	return [minX, minY, maxX, maxY];
}

// _bbox lets a pin tap frame its polygon.
function buildCentroidFC(
	features: Feature[],
): Record<CentroidKind, FeatureCollection> {
	const out: Record<CentroidKind, Feature[]> = { block: [], polygon: [] };
	for (const feat of features) {
		const g = feat.geometry;
		if (g?.type !== "Polygon" && g?.type !== "MultiPolygon") continue;
		const bbox = geometryBbox(g);
		if (!bbox) continue;
		const fullName = String(feat.properties?.name ?? "").trim();
		const rawHandle =
			String(feat.properties?.displayName ?? "").trim() ||
			(fullName === "" ? "" : deriveHandle(fullName));
		const name =
			rawHandle !== "" && rawHandle !== fullName
				? `${rawHandle}…`
				: rawHandle;
		out[isBlockFeature(feat) ? "block" : "polygon"].push({
			type: "Feature",
			geometry: {
				type: "Point",
				coordinates: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
			},
			properties: {
				...(name === "" ? {} : { _nameLabel: name }),
				_bbox: bbox,
			},
		});
	}
	return {
		block: { type: "FeatureCollection", features: out.block },
		polygon: { type: "FeatureCollection", features: out.polygon },
	};
}

export function setCentroidSources(
	setSource: (id: string, data: FeatureCollection) => void,
	features: Feature[],
): void {
	const fcs = buildCentroidFC(features);
	for (const kind of CENTROID_KINDS)
		setSource(centroidSourceId(kind), fcs[kind]);
}

function parseBbox(raw: unknown): RingBbox | null {
	let arr: unknown = raw;
	if (typeof raw === "string") {
		try {
			arr = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	return Array.isArray(arr) &&
		arr.length === 4 &&
		arr.every((n) => Number.isFinite(n))
		? (arr as RingBbox)
		: null;
}

export function boundaryPinAt(
	map: MapboxMap,
	point: { x: number; y: number },
): boolean {
	const layers = CENTROID_PIN_LAYERS.filter((l) => map.getLayer(l));
	if (layers.length === 0) return false;
	return map.queryRenderedFeatures([point.x, point.y], { layers }).length > 0;
}

const boundaryPinWired = new WeakSet<MapboxMap>();

export function wireBoundaryPinNavigation(
	map: MapboxMap,
	isNavigationAllowed: () => boolean = () => true,
): void {
	if (boundaryPinWired.has(map)) return;
	boundaryPinWired.add(map);

	for (const layer of CENTROID_PIN_LAYERS) {
		map.on("click", layer, (e) => {
			if (!isNavigationAllowed()) return;
			const f = map.queryRenderedFeatures(e.point, {
				layers: [layer],
			})[0];
			if (!f) return;
			const clusterId = f.properties?.cluster_id as number | undefined;
			if (clusterId != null) {
				const src = map.getSource(
					(map.getLayer(layer) as { source: string }).source,
				) as GeoJSONSource | undefined;
				if (!src) return;
				src.getClusterExpansionZoom(clusterId, (err, zoom) => {
					if (err || zoom == null) return;
					const center = (f.geometry as Point).coordinates;
					safeEaseTo(map, { center: center as Lnglat, zoom });
				});
				return;
			}
			const bbox = parseBbox(f.properties?._bbox);
			if (!bbox) return;
			safeFitBounds(
				map,
				[bbox[0], bbox[1]],
				[bbox[2], bbox[3]],
				{ padding: 80, maxZoom: 15, duration: 700 },
			);
		});
	}
	for (const layer of CENTROID_PIN_LAYERS) {
		map.on("mouseenter", layer, () => {
			map.getCanvas().style.cursor = "pointer";
		});
		map.on("mouseleave", layer, () => {
			map.getCanvas().style.cursor = "";
		});
	}
}

export function buildDrawEdgesFC(vertices: Lnglat[]): FeatureCollection {
	if (vertices.length < 2) return emptyFC();
	return {
		type: "FeatureCollection",
		features: [
			{
				type: "Feature",
				geometry: { type: "LineString", coordinates: vertices },
				properties: {},
			},
		],
	};
}

export function buildDrawVerticesFC(vertices: Lnglat[]): FeatureCollection {
	return {
		type: "FeatureCollection",
		features: vertices.map((coord) => ({
			type: "Feature" as const,
			geometry: { type: "Point" as const, coordinates: coord },
			properties: {},
		})),
	};
}

export function buildProvisionalPolygonFC(
	vertices: Lnglat[],
	intent: DrawIntent,
): FeatureCollection {
	if (intent !== "polygon" || vertices.length < 2) return emptyFC();

	const ring = [...vertices, vertices[0]];
	const closingEdge = [vertices[vertices.length - 1], vertices[0]];

	const features: Feature[] = [
		{
			type: "Feature",
			geometry: { type: "LineString", coordinates: closingEdge },
			properties: {},
		},
	];
	if (vertices.length >= 3) {
		features.push({
			type: "Feature",
			geometry: { type: "Polygon", coordinates: [ring] },
			properties: {},
		});
	}
	return { type: "FeatureCollection", features };
}

export function buildCompletedFC(features: Feature[]): FeatureCollection {
	const out: Feature[] = [];
	// Stamped onto FC copies, never stored features: colour re-derives on every rebuild.
	const overlapColors = assignOverlapColors(features);
	for (let i = 0; i < features.length; i++) {
		const feat = features[i];
		if (feat.geometry?.type === "Point") continue;
		const overlapColor = overlapColors.get(i);
		const isBlock = isBlockFeature(feat);
		out.push({
			...feat,
			properties: {
				...(feat.properties ?? {}),
				_idx: i,
				...(isBlock ? { _isBlock: true } : {}),
				...(overlapColor
					? {
						  _fillCol: overlapColor.fill,
						  _strokeCol: overlapColor.stroke,
						  _stackFillOp: STACKED_FILL_OPACITY,
					  }
					: {}),
			},
		});

		if (feat.geometry?.type === "Polygon") {
			const ring = (feat.geometry as Polygon).coordinates[0];
			const last = ring.length - 1;
			const closes =
				ring.length > 1 &&
				ring[0][0] === ring[last][0] &&
				ring[0][1] === ring[last][1];
			const stop = closes ? last : ring.length;
			for (let v = 0; v < stop; v++) {
				out.push({
					type: "Feature",
					geometry: {
						type: "Point",
						coordinates: ring[v],
					} as Point,
					properties: {
						_idx: i,
						_vertexIdx: v,
						_isEndpoint: false,
						_parentType: "Polygon",
						...(isBlock ? { _parentIsBlock: true } : {}),
						...(overlapColor
							? { _strokeCol: overlapColor.stroke }
							: {}),
					},
				});
			}
		} else if (feat.geometry?.type === "LineString") {
			const coords = (feat.geometry as LineString).coordinates;
			const isTrack = feat.properties?.featureType === "track";
			for (let v = 0; v < coords.length; v++) {
				const coord = coords[v];
				const isEndpoint = v === 0 || v === coords.length - 1;
				out.push({
					type: "Feature",
					geometry: { type: "Point", coordinates: coord } as Point,
					properties: {
						_idx: i,
						_vertexIdx: v,
						_isEndpoint: isEndpoint,
						_parentType: "LineString",
						...(isTrack ? { _isTrack: true } : {}),
					},
				});
			}
		}
	}
	return { type: "FeatureCollection", features: out };
}

export interface PixelBbox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export function projectLnglatBbox(
	map: MapboxMap,
	coords: ReadonlyArray<Lnglat | number[]>,
): PixelBbox | null {
	if (coords.length === 0) return null;
	let minX = Infinity,
		maxX = -Infinity,
		minY = Infinity,
		maxY = -Infinity;
	for (const c of coords) {
		const pt = map.project({ lng: c[0], lat: c[1] });
		if (pt.x < minX) minX = pt.x;
		if (pt.x > maxX) maxX = pt.x;
		if (pt.y < minY) minY = pt.y;
		if (pt.y > maxY) maxY = pt.y;
	}
	return { minX, minY, maxX, maxY };
}

export function projectFeatureBbox(
	map: MapboxMap,
	feature: Feature,
): PixelBbox | null {
	if (!feature.geometry) return null;
	let coords: number[][] = [];
	if (feature.geometry.type === "Polygon") {
		coords = (feature.geometry as Polygon).coordinates[0];
	} else if (feature.geometry.type === "LineString") {
		coords = (feature.geometry as LineString).coordinates;
	} else if (feature.geometry.type === "Point") {
		coords = [(feature.geometry as Point).coordinates];
	}
	return projectLnglatBbox(map, coords);
}

// 12px: thin lines are unhittable at tap precision.
export function hitTestCompleted(
	map: MapboxMap,
	point: { x: number; y: number },
	tolerancePx = 12,
): number | null {
	const layers = [
		"completed-fill",
		"completed-stroke",
		"completed-vertices-halo",
		"completed-vertices-dot",
	];
	const r = Math.max(0, tolerancePx);
	const bbox: [[number, number], [number, number]] = [
		[point.x - r, point.y - r],
		[point.x + r, point.y + r],
	];
	const hits = map.queryRenderedFeatures(bbox, { layers });
	if (hits.length === 0) return null;
	const idx = hits[0].properties?._idx;
	return typeof idx === "number" ? idx : null;
}

export function clearInProgressSources(map: MapboxMap): void {
	const empty = emptyFC();
	for (const id of DRAW_SOURCE_IDS) {
		const src = map.getSource(id);
		if (src && "setData" in src) {
			(
				src as unknown as { setData: (d: FeatureCollection) => void }
			).setData(empty);
		}
	}
}

export function finalizeFeature(
	intent: Exclude<DrawIntent, null>,
	vertices: Lnglat[],
): Feature {
	const id = newId();
	if (intent === "polygon") {
		const ring = [...vertices, vertices[0]];
		return {
			type: "Feature",
			id,
			geometry: { type: "Polygon", coordinates: [ring] },
			properties: { name: "", notes: "" },
		};
	}
	if (intent === "pin") {
		return {
			type: "Feature",
			id,
			geometry: { type: "Point", coordinates: vertices[0] },
			properties: { name: "", notes: "" },
		};
	}
	return {
		type: "Feature",
		id,
		geometry: { type: "LineString", coordinates: [...vertices] },
		properties: { name: "", notes: "" },
	};
}
