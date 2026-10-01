/**
 * "@Match Time help badges [name]" (Kemal, 2026-10-01). Deterministic, no
 * model, the same in the group and by DM.
 *
 *   - no name: every badge, one line each (emoji, name, rule), then where
 *     badges come from, which can be lost, and how to ask about one;
 *   - a name that resolves (resolveBadgeName): that badge's full rules;
 *   - a name that does not: a line saying so, then the list.
 *
 * The numbers come from BADGE_NUMBERS, i.e. the constants the stats page
 * awards the badges with, so this can never disagree with the page.
 */
import { BADGES, BADGE_NUMBERS, resolveBadgeName } from "./badge-rules";
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";

/** The badge the drill-down hint uses as its example. */
const EXAMPLE = BADGES.find((b) => b.key === "reliable")!.label;

export function buildBadgeHelp(query: string | undefined, lang: Lang | string, opts: { dm: boolean }): string {
  const s = t(lang);
  const q = (query ?? "").trim().slice(0, 40);
  const key = q ? resolveBadgeName(q) : null;
  if (key) {
    const b = BADGES.find((x) => x.key === key)!;
    return `${s.onbHelpBadgeDetail({ ...b, n: BADGE_NUMBERS })}\n\n${s.onbHelpBadgesClubNote()}`;
  }
  const list = [s.onbHelpBadgesHead(), ...BADGES.map((b) => s.onbHelpBadgeLine({ ...b, n: BADGE_NUMBERS }))].join("\n");
  const body = `${list}\n\n${s.onbHelpBadgesFoot({ dm: opts.dm, example: EXAMPLE })}`;
  return q ? `${s.onbHelpBadgesUnknown({ query: q })}\n\n${body}` : body;
}
