/**
 * The help menus' topics and their icons, the same in every language
 * (Kemal, 2026-11-10: "display what help menu items are there with only
 * one liner explanation for each"). Each language's table words the
 * one-liners (`onbHelpMenu`, `hq_help_menu`); the icon is shared so the
 * two languages' menus line up.
 */

/** The players' group and DM menu's topics (the help's `HelpTopic`). */
export type HelpMenuTopic =
  | "availability"
  | "friend"
  | "teams"
  | "mom"
  | "ratings"
  | "badges"
  | "reminders"
  | "payments"
  | "partners"
  | "pool"
  | "schedule"
  | "settings";

/** The admin group (HQ) menu's topics: its own, then the players' topics
 *  an organiser can ask about there. */
export type HqMenuTopic =
  | "squad"
  | "teams"
  | "players"
  | "game"
  | "settings"
  | "graphics"
  | "payments"
  | "partners"
  | "pool"
  | "mom"
  | "ratings"
  | "reminders";

/** One menu line's topic, and whether it is switched off here (marked
 *  for the organisers only). */
export interface MenuTopic<T extends string> {
  topic: T;
  off?: boolean;
}

export const HELP_MENU_ICON: Record<HelpMenuTopic, string> = {
  availability: "✅",
  friend: "👫",
  teams: "🟥🟦",
  mom: "⭐",
  ratings: "📈",
  badges: "🏅",
  reminders: "⏰",
  payments: "💷",
  partners: "🤝",
  pool: "🌍",
  schedule: "📅",
  settings: "⚙️",
};

export const HQ_MENU_ICON: Record<HqMenuTopic, string> = {
  squad: "📋",
  teams: "🟥🟦",
  players: "📣",
  game: "🗓️",
  settings: "⚙️",
  graphics: "🖼️",
  payments: "💷",
  partners: "🤝",
  pool: "🌍",
  mom: "⭐",
  ratings: "📈",
  reminders: "⏰",
};
