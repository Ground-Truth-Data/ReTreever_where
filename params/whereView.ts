// Anything else under /where falls through to its own route or 404s rather than being swallowed.
export const WHERE_VIEWS = ["orgs", "projects"] as const;
export type WhereView = (typeof WHERE_VIEWS)[number];

export const match = (param: string): param is WhereView =>
	(WHERE_VIEWS as readonly string[]).includes(param);
