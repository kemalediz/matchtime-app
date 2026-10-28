/**
 * WHERE THE HELP POINTS ON THE SETTINGS PAGE (2026-10-28).
 *
 * Every help topic that has a switch links straight to its card on
 * /admin/settings, by a FIXED anchor id the settings page gives that card
 * (the settings redesign builds the ids; the list below is the agreed one
 * and is meant to be merged with that work's own module). A topic with no
 * card of its own (the schedule, badges, settings as a whole) links to the
 * page itself.
 *
 * Pure: no database, no request. `appUrl` turns a path into the public URL;
 * an organiser's DM swaps it for a link that signs him in (dm-help.ts).
 */
import type { HelpFeature } from "./pipeline/types";

/** The settings page's card anchors, fixed. */
export const SETTINGS_ANCHORS = [
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
] as const;
export type SettingsAnchor = (typeof SETTINGS_ANCHORS)[number];

export const SETTINGS_PATH = "/admin/settings";

/** The path of one card on the settings page. */
export function settingsAnchorPath(id: SettingsAnchor): string {
  return `${SETTINGS_PATH}#${id}`;
}

/** The card each help topic switches on or off. A topic missing here has
 *  no card of its own. */
export const HELP_TOPIC_ANCHOR: Partial<Record<HelpFeature, SettingsAnchor>> = {
  availability: "attendance",
  teams: "teams",
  mom: "mom",
  ratings: "ratings",
  reminders: "reminders",
  payments: "payments",
  partners: "partner-clubs",
  pool: "player-pool",
};

/** Where a topic's settings live: its card, or the settings page. */
export function helpTopicSettingsPath(topic: HelpFeature | null): string {
  const anchor = topic ? HELP_TOPIC_ANCHOR[topic] : undefined;
  return anchor ? settingsAnchorPath(anchor) : SETTINGS_PATH;
}
