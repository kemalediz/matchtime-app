/**
 * THE NAME A PLAYER IS LISTED UNDER, on every squad surface (2026-10-22).
 *
 * Prod, MT Test: a partner guest whose `User.name` was NULL was listed as
 * a hard-coded English "(unnamed)", and neither guest line said which club
 * he came from. The cross-club plan (D7): a guest is shown by "name and
 * club only" ("Ali K (Sutton FC)"), never a phone number.
 *
 * The order, once:
 *   1. `User.name`;
 *   2. this club's `UserAlias` (oldest first);
 *   3. for a partner guest, his HOME club's `UserAlias`;
 *   4. nothing: `resolvePlayerName` is null and the display line is the
 *      group's own word for "unnamed" (`s.unnamed`, EN and TR).
 * A partner guest's line then gets " (Home club)" appended.
 *
 * A phone number is never a name, at any step. Aliases are stored
 * normalised (lower case, accents stripped), so they are capitalised
 * word by word for display.
 *
 * `name` is the plain name, for surfaces that shorten it themselves (the
 * poster prints first names only). `display` is the squad-list line.
 * Callers that MATCH people (the router, claim checks) keep reading
 * `User.name`: this is for printing only.
 */
import { db } from "./db";
import { t } from "./i18n/t";
import { normaliseLang, type Lang } from "./i18n/lang";

const RAW_PHONE = /(?:\+\d[\d\s().-]{8,}\d)|(?:\b0\d{9,10}\b)|(?:\b\d{11,}\b)/;

/** The name as printed: whitespace collapsed and trimmed, or null when it
 *  is empty, has no letter, or is a phone number. */
export function usableName(raw: string | null | undefined): string | null {
  const v = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!v || RAW_PHONE.test(v) || !/\p{L}/u.test(v)) return null;
  return v;
}

function capitalise(alias: string, lang?: Lang | string | null): string {
  const locale = normaliseLang(lang) === "tr" ? "tr" : "en";
  return alias
    .split(" ")
    .map((w) => (w ? w.charAt(0).toLocaleUpperCase(locale) + w.slice(1) : w))
    .join(" ");
}

export interface PlayerNameFacts {
  name: string | null | undefined;
  /** `UserAlias.alias` rows at THIS club, oldest first. */
  aliasesHere?: readonly string[];
  /** For a partner guest: `UserAlias.alias` rows at his home club. */
  aliasesHome?: readonly string[];
  /** For a partner guest: his home club's name. Absent for a member. */
  guestClubName?: string | null;
}

/** The best real name MatchTime holds, or null when it holds none. */
export function resolvePlayerName(f: PlayerNameFacts, lang?: Lang | string | null): string | null {
  const own = usableName(f.name);
  if (own) return own;
  for (const a of [...(f.aliasesHere ?? []), ...(f.aliasesHome ?? [])]) {
    const v = usableName(a);
    if (v) return capitalise(v, lang);
  }
  return null;
}

/** The squad-list line: the name (or `s.unnamed`), plus " (Club)" for a guest. */
export function playerDisplayName(f: PlayerNameFacts, lang?: Lang | string | null): string {
  const base = resolvePlayerName(f, lang) ?? t(lang).unnamed;
  const club = (f.guestClubName ?? "").trim();
  return club ? `${base} (${club})` : base;
}

export interface PlayerNames {
  name: string | null;
  display: string;
}

/**
 * Both names for each of `userIds` at club `orgId`: four reads at most
 * (users, this club's memberships, the aliases, the guests' home clubs).
 * A user missing from the map is printed by the caller's own fallback.
 *
 * FAILS SOFT: this only improves how a name is printed, so a failed read
 * is logged (ids only) and returns an empty map. The squad post still goes
 * out with the plain names rather than not at all.
 */
export async function loadPlayerNames(
  orgId: string,
  userIds: readonly string[],
  lang?: Lang | string | null,
): Promise<Map<string, PlayerNames>> {
  try {
    return await loadPlayerNamesOrThrow(orgId, userIds, lang);
  } catch (err) {
    console.error(`[player-display-name] org=${orgId} names=${userIds.length} lookup failed:`, err instanceof Error ? err.message : "failed");
    return new Map();
  }
}

async function loadPlayerNamesOrThrow(
  orgId: string,
  userIds: readonly string[],
  lang?: Lang | string | null,
): Promise<Map<string, PlayerNames>> {
  const out = new Map<string, PlayerNames>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return out;

  const [users, mems] = await Promise.all([
    db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    db.membership.findMany({ where: { orgId, userId: { in: ids } }, select: { userId: true, guestFromOrgId: true } }),
  ]);
  const homeOf = new Map(mems.filter((m) => m.guestFromOrgId).map((m) => [m.userId, m.guestFromOrgId as string]));
  const homeIds = [...new Set(homeOf.values())];
  const [aliases, homes] = await Promise.all([
    db.userAlias.findMany({
      where: { userId: { in: ids }, orgId: { in: [orgId, ...homeIds] } },
      select: { userId: true, orgId: true, alias: true },
      orderBy: { createdAt: "asc" },
    }),
    homeIds.length > 0
      ? db.organisation.findMany({ where: { id: { in: homeIds } }, select: { id: true, name: true } })
      : Promise.resolve([] as Array<{ id: string; name: string }>),
  ]);
  const clubName = new Map(homes.map((o) => [o.id, o.name]));

  for (const u of users) {
    const home = homeOf.get(u.id) ?? null;
    const facts: PlayerNameFacts = {
      name: u.name,
      aliasesHere: aliases.filter((a) => a.userId === u.id && a.orgId === orgId).map((a) => a.alias),
      aliasesHome: home ? aliases.filter((a) => a.userId === u.id && a.orgId === home).map((a) => a.alias) : [],
      guestClubName: home ? (clubName.get(home) ?? null) : null,
    };
    out.set(u.id, { name: resolvePlayerName(facts, lang), display: playerDisplayName(facts, lang) });
  }
  return out;
}
