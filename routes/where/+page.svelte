<script lang="ts">
import { dev } from "$app/environment";
import WherePage from "../../lib/WherePage.svelte";
import EphemeralCard from "$rig/dev/EphemeralCard.svelte";
import EphemeralDock from "$rig/dev/EphemeralDock.svelte";
import type { FavouriteLocation, WhereRoutes } from "../../lib/whereTypes";
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
<!-- Gated at the CALL SITE, not only inside the dock. EphemeralDock and
     EphemeralCard each carry their own `{#if dev}`, which stops them
     rendering but cannot stop them shipping: an unconditional mount is a
     live reference the bundler must keep, so the dev card and devCard.css
     travelled into production builds. A component gating itself can never
     delete its own call site — only the caller can. -->
{#if dev}
	<EphemeralDock side="left"><EphemeralCard title="where" /></EphemeralDock>
{/if}
