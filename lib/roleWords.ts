import { m } from "$parent/src/lib/paraglide/messages";
import { getLocale } from "$parent/src/lib/paraglide/runtime";

// Keyed by StakeholderCategoryTable ids; a role with no word here shows no label.
const ROLE_WORDS: Record<string, () => string> = {
	developer_ish: m.wh_role_developer,
	producer_ish: m.wh_role_producer,
	landowner_ish: m.wh_role_landowner,
	sponsor_ish: m.wh_role_sponsor,
	marketplace_ish: m.wh_role_marketplace,
	research_ish: m.wh_role_research,
};

/** An org's roles as the drawer and a land's link preview both say them: "Developer and Landowner". */
export const roleWords = (roles: string[]) =>
	new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(roles.flatMap((r) => (ROLE_WORDS[r] ? [ROLE_WORDS[r]()] : [])));

/** Hectares as the drawer shows them: whole, grouped for the reader's language. */
export const formatHectares = (hectares: number) => Math.round(hectares).toLocaleString(getLocale());
