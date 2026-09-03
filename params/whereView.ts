/**
 * The two map views a URL segment can name — /where/orgs and /where/projects
 * share one dynamic route (`[view=whereView]`) beside the bare /where, all
 * rendered by routes/where/+layout.svelte so the globe never remounts on a
 * toggle. Anything else under /where falls through to its own static route
 * (a host's own debug page, say) or 404s rather than being swallowed.
 */
export const WHERE_VIEWS = ["orgs", "projects"] as const;
export type WhereView = (typeof WHERE_VIEWS)[number];

export const match = (param: string): param is WhereView =>
	(WHERE_VIEWS as readonly string[]).includes(param);
