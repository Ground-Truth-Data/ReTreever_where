<script lang="ts">
import WherePage from "../lib/WherePage.svelte";
import type { FavouriteLocation, WhereRoutes } from "../lib/whereTypes";
import type { Feature } from "geojson";

type HostProps = {
	initialFeatures?: Feature[];
	onFeatureComplete?: (feature: Feature) => void;
	onFeaturesCleared?: () => void;
	favourites?: FavouriteLocation[];
	ontogglefavourite?: (loc: FavouriteLocation) => void;
	routes?: WhereRoutes;
	ensureMapboxGuards?: () => Promise<void>;
};

let { hostProps }: { hostProps?: HostProps } = $props();

// Session-only, in memory — a child owns no storage; inventing a localStorage key here would put a child's data in whichever product happened to mount it.
let favourites = $state<FavouriteLocation[]>([]);

function toggleFavourite(loc: FavouriteLocation) {
	favourites = favourites.some((f) => f.landKey === loc.landKey)
		? favourites.filter((f) => f.landKey !== loc.landKey)
		: [...favourites, loc];
}
</script>

{#if hostProps}
	<WherePage {...hostProps} />
{:else}
	<WherePage {favourites} ontogglefavourite={toggleFavourite} />
{/if}
