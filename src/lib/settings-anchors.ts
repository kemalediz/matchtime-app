/**
 * WHERE EVERY CARD ON /admin/settings LIVES (2026-10-28).
 *
 * The settings page is six tabs of collapsible cards. Every card has a
 * stable id, used three ways:
 *   - as the card's DOM id, so `/admin/settings#<id>` opens its tab,
 *     expands it and scrolls to it;
 *   - by links from elsewhere (help answers, DMs, banners) through
 *     `settingsUrl(id)`;
 *   - by the "Find a setting" box, which picks a card by id.
 *
 * THE IDS ARE FIXED. Help links are built against them; renaming one
 * breaks every link already sent. Add new ones, never rename.
 *
 * Pure, client-safe: no database, no React.
 */

export const SETTINGS_TABS = ["club", "matches", "players", "payments", "finding", "messages"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** The tab a page opens on when the address names none. */
export const DEFAULT_SETTINGS_TAB: SettingsTab = "club";

/**
 * Every card, in the order it is drawn, and its tab. A card's id is its
 * DOM id. Some cards show only for some clubs (the pool cards while the
 * club has the player pool, Payments' bank part while fees are collected,
 * Billing while the club pays MatchTime); the id stays the same.
 */
export const SETTINGS_CARDS = [
  // Club
  { id: "club-details", tab: "club" },
  { id: "bot-language", tab: "club" },
  { id: "whatsapp", tab: "club" },
  // Matches
  { id: "weekly-routine", tab: "matches" },
  { id: "reminders", tab: "matches" },
  { id: "teams", tab: "matches" },
  { id: "monthly-squad", tab: "matches" },
  // Players
  { id: "attendance", tab: "players" },
  { id: "bench", tab: "players" },
  { id: "ratings", tab: "players" },
  { id: "mom", tab: "players" },
  { id: "invite-link", tab: "players" },
  // Payments
  { id: "payments", tab: "payments" },
  { id: "billing", tab: "payments" },
  // Finding players
  { id: "partner-clubs", tab: "finding" },
  { id: "player-pool", tab: "finding" },
  { id: "play-style", tab: "finding" },
  { id: "pool-auto-ask", tab: "finding" },
  { id: "pool-club-share", tab: "finding" },
  { id: "group-invite-link", tab: "finding" },
  // Messages
  { id: "quiet-hours", tab: "messages" },
  { id: "admin-group", tab: "messages" },
  { id: "posters", tab: "messages" },
] as const satisfies ReadonlyArray<{ id: string; tab: SettingsTab }>;

export type SettingsCardId = (typeof SETTINGS_CARDS)[number]["id"];

/**
 * The ids help links are built against (the brief of 2026-10-28). Each is
 * a card above; `settings-anchors.test.ts` proves it.
 */
export const HELP_LINK_IDS = [
  "player-pool",
  "partner-clubs",
  "pool-auto-ask",
  "play-style",
  "pool-club-share",
  "group-invite-link",
  "quiet-hours",
  "payments",
  "monthly-squad",
  "posters",
  "billing",
  "reminders",
  "attendance",
  "ratings",
  "mom",
  "teams",
  "club-details",
  "admin-group",
] as const satisfies ReadonlyArray<SettingsCardId>;

/**
 * Ids INSIDE a card that links already point at, and the card they live
 * in. Opening one expands its card and scrolls to the inner spot.
 */
const INNER_ANCHORS: Record<string, SettingsCardId> = {
  // The weekly venue reminder and the find-clubs page (partner discovery, P1).
  "club-venue": "partner-clubs",
  // Rows of the weekly routine that suggestions link to.
  "wr-announce": "weekly-routine",
  "wr-pick": "bench",
};

/**
 * Ids ABOVE the tabs (the Go live banner, what MatchTime learned from the
 * chat). They are on every tab, so they open no tab and no card.
 */
const PAGE_ANCHORS = new Set(["go-live", "learned-setup"]);

const BY_ID = new Map<string, SettingsTab>(SETTINGS_CARDS.map((c) => [c.id, c.tab]));

export function isSettingsCardId(id: string): id is SettingsCardId {
  return BY_ID.has(id);
}

export function tabOfCard(id: SettingsCardId): SettingsTab {
  return BY_ID.get(id)!;
}

export function cardsOfTab(tab: SettingsTab): SettingsCardId[] {
  return SETTINGS_CARDS.filter((c) => c.tab === tab).map((c) => c.id);
}

/** The settings page at one card: `/admin/settings#<id>`. */
export function settingsUrl(id: SettingsCardId): string {
  return `/admin/settings#${id}`;
}

/** A `?tab=` value, or null when it names no tab. */
export function parseSettingsTab(value: string | null | undefined): SettingsTab | null {
  return (SETTINGS_TABS as readonly string[]).includes(value ?? "") ? (value as SettingsTab) : null;
}

export type SettingsHashTarget =
  /** A card, or a spot inside one: open `tab`, expand `card`, scroll to `scrollTo`. */
  | { kind: "card"; tab: SettingsTab; card: SettingsCardId; scrollTo: string }
  /** Something above the tabs: scroll to it, change nothing else. */
  | { kind: "page"; scrollTo: string };

/** What `#<hash>` (with or without the #) opens. Null for anything else. */
export function resolveSettingsHash(hash: string | null | undefined): SettingsHashTarget | null {
  let id = (hash ?? "").replace(/^#/, "").trim();
  try {
    id = decodeURIComponent(id);
  } catch {
    /* keep it as it came */
  }
  if (!id) return null;
  if (isSettingsCardId(id)) return { kind: "card", tab: tabOfCard(id), card: id, scrollTo: id };
  const inner = INNER_ANCHORS[id];
  if (inner) return { kind: "card", tab: tabOfCard(inner), card: inner, scrollTo: id };
  if (PAGE_ANCHORS.has(id)) return { kind: "page", scrollTo: id };
  return null;
}

/**
 * The tab the page opens on: a deep link's tab first, then `?tab=`, then
 * Payments when the organiser is coming back from Stripe's bank setup,
 * then the default.
 */
export function initialSettingsTab(loc: { hash?: string | null; search?: string | null }): SettingsTab {
  const target = resolveSettingsHash(loc.hash);
  if (target?.kind === "card") return target.tab;
  const params = new URLSearchParams(loc.search ?? "");
  const named = parseSettingsTab(params.get("tab"));
  if (named) return named;
  if (params.has("stripe")) return "payments";
  return DEFAULT_SETTINGS_TAB;
}

/** The address after choosing `tab`: the same page and query with `tab`
 *  set, and no #card (the card it named is on another tab now). */
export function settingsTabHref(tab: SettingsTab, loc: { pathname: string; search: string }): string {
  const params = new URLSearchParams(loc.search);
  params.set("tab", tab);
  return `${loc.pathname}?${params.toString()}`;
}
