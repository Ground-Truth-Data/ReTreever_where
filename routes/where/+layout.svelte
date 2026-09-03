<script lang="ts">
import { page } from "$app/stores";
import WherePage from "../../lib/WherePage.svelte";
import type { FavouriteLocation, WhereRoutes } from "../../lib/whereTypes";
import type { WhereView } from "../../params/whereView";
import type { Feature } from "geojson";
import type { Snippet } from "svelte";

type HostProps = {
	initialFeatures?: Feature[];
	onFeatureComplete?: (feature: Feature) => void;
	onFeaturesCleared?: () => void;
	favourites?: FavouriteLocation[];
	ontogglefavourite?: (loc: FavouriteLocation) => void;
	routes?: WhereRoutes;
	ensureMapboxGuards?: () => Promise<void>;
};

// A LAYOUT, not a page: /where, /where/orgs and /where/projects are three
// routes under it, each an empty +page.svelte. The map is built once here and
// a view toggle only changes `view` — a page would remount the globe.
let {
	hostProps,
	children,
}: { hostProps?: HostProps; children?: Snippet } = $props();

let view = $derived(($page.params.view as WhereView | undefined) ?? null);

// Session-only, in memory — a child owns no storage; inventing a localStorage key here would put a child's data in whichever product happened to mount it.
let favourites = $state<FavouriteLocation[]>([]);

function toggleFavourite(loc: FavouriteLocation) {
	favourites = favourites.some((f) => f.landKey === loc.landKey)
		? favourites.filter((f) => f.landKey !== loc.landKey)
		: [...favourites, loc];
}
</script>

{#if hostProps}
	<WherePage {...hostProps} {view} />
{:else}
	<WherePage {favourites} ontogglefavourite={toggleFavourite} {view} />
{/if}

{@render children?.()}
