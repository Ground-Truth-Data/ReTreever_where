<script lang="ts">
// /where's own draw engine: it draws a shape and hands it back, nothing more.
import type { Map as MapboxMap } from "mapbox-gl";
import type { Feature } from "geojson";
import {
	buildCompletedFC,
	buildDrawEdgesFC,
	buildDrawVerticesFC,
	buildProvisionalPolygonFC,
	clearInProgressSources,
	getAccentColor,
	setupDrawSourcesAndLayers,
	type DrawIntent,
	type Lnglat,
} from "./mapDraw";
import { newId } from "./newId";

let {
	map,
	drawIntent = $bindable(null),
	initialFeatures = [],
	onFeatureComplete,
}: {
	map?: MapboxMap;
	drawIntent?: DrawIntent;
	initialFeatures?: Feature[];
	onFeatureComplete?: (feature: Feature) => void;
} = $props();

let features = $state<Feature[]>([...initialFeatures]);
let vertices = $state<Lnglat[]>([]);

function setSource(id: string, data: ReturnType<typeof buildCompletedFC>) {
	if (!map) return;
	const src = map.getSource(id);
	if (src && "setData" in src) {
		(src as unknown as { setData: (d: typeof data) => void }).setData(data);
	}
}

// Seed through onPainted: a push into sources that don't exist yet is dropped for good.
$effect(() => {
	const m = map;
	if (!m) return;
	if (!m.getSource("completed-features")) {
		setupDrawSourcesAndLayers(m, getAccentColor(), true, () => {
			setSource("completed-features", buildCompletedFC(features));
		});
		return;
	}
	setSource("completed-features", buildCompletedFC(features));
});

$effect(() => {
	if (!map) return;
	setSource("draw-edges", buildDrawEdgesFC(vertices));
	setSource("draw-vertices", buildDrawVerticesFC(vertices));
	setSource("provisional-polygon", buildProvisionalPolygonFC(vertices, "polygon"));
});

function finish() {
	if (!map) return;
	const min = drawIntent === "polygon" ? 3 : 2;
	if (vertices.length >= min) {
		const feature: Feature =
			drawIntent === "polygon"
				? {
						type: "Feature",
						id: newId(),
						properties: {},
						geometry: {
							type: "Polygon",
							coordinates: [[...vertices, vertices[0]]],
						},
					}
				: {
						type: "Feature",
						id: newId(),
						properties: {},
						geometry: { type: "LineString", coordinates: [...vertices] },
					};
		features = [...features, feature];
		onFeatureComplete?.(feature);
	}
	vertices = [];
	clearInProgressSources(map);
	drawIntent = null;
}

$effect(() => {
	const m = map;
	if (!m) return;

	const onClick = (e: { lngLat: { lng: number; lat: number } }) => {
		if (!drawIntent) return;
		vertices = [...vertices, [e.lngLat.lng, e.lngLat.lat]];
	};
	const onDblClick = () => {
		if (drawIntent) finish();
	};

	m.on("click", onClick);
	m.on("dblclick", onDblClick);
	return () => {
		m.off("click", onClick);
		m.off("dblclick", onDblClick);
	};
});

// Mapbox's own dblclick zoom would yank the camera at the closing tap.
$effect(() => {
	const m = map;
	if (!m) return;
	if (drawIntent) m.doubleClickZoom.disable();
	else m.doubleClickZoom.enable();
});

export function setMode(mode: DrawIntent) {
	if (map && vertices.length) clearInProgressSources(map);
	vertices = [];
	drawIntent = mode;
}

export function clearAll() {
	features = [];
	vertices = [];
	if (map) clearInProgressSources(map);
	drawIntent = null;
	setSource("completed-features", buildCompletedFC([]));
}
</script>
