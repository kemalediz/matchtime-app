/**
 * The words of the /admin/settings LAYOUT (2026-10-28): the tabs, the
 * "Find a setting" box, the titles of the cards the layout made, and the
 * one-line summaries a collapsed card shows. CLIENT-SAFE.
 *
 * One object per language (`settings-nav.en.ts`, `settings-nav.tr.ts`),
 * typed by `SettingsNavCopy`, so a missing line in either is a `tsc`
 * error. House rules (unit tested in `__tests__/settings-nav-copy.test.ts`):
 * no em or en dashes, no slash as a separator, never "free", always
 * "bench", Turkish never equal to English. Turkish values sit where they
 * need no case suffix, or the suffix comes from `trLocative`.
 */
import { normaliseLang, type Lang } from "./lang";
import type { SettingsTab } from "../settings-anchors";
import { SETTINGS_NAV_EN } from "./settings-nav.en";
import { SETTINGS_NAV_TR } from "./settings-nav.tr";

export interface SettingsNavCopy {
  tabs: Record<SettingsTab, string>;
  /** The tab row's accessible name. */
  tabsLabel: string;
  find: {
    label: string;
    results: string;
    none: string;
    clear: string;
  };
  /** Card titles the layout made (cards split out of "Bot features"). */
  titles: {
    attendance: string;
    bench: string;
    ratings: string;
    mom: string;
    teams: string;
    reminders: string;
    payments: string;
    adminGroup: string;
    billing: string;
  };
  /** "On" and "Off" on their own, and inside a list ("Rolling squad: on"). */
  on: string;
  off: string;
  onInList: string;
  offInList: string;
  summary: {
    members: (n: number) => string;
    whatsappOn: string;
    weeklyDeadlines: (n: number) => string;
    weeklySquad: string;
    monthlySquad: string;
    teamsBoth: (first: string, second: string) => string;
    benchFirstCome: string;
    benchOrganiser: string;
    momPlayers: string;
    momOrganisers: string;
    inviteLink: string;
    paymentsOff: string;
    paymentsBank: string;
    paymentsNoBank: string;
    partnersNone: string;
    partners: (n: number) => string;
    partnerRequests: (n: number) => string;
    poolAutoAsk: string;
    playStyleNotSet: string;
    clubShareReady: string;
    clubShareNoGroup: string;
    inviteLinkBot: string;
    inviteLinkPasted: string;
    inviteLinkNone: string;
    quietHoursOn: (from: string, to: string) => string;
    adminOnePerson: string;
    adminGroupLinked: (group: string) => string;
    adminGroupNotLinked: string;
    adminEachAdmin: string;
  };
}

const BY_LANG: Record<Lang, SettingsNavCopy> = { en: SETTINGS_NAV_EN, tr: SETTINGS_NAV_TR };

export function settingsNavCopy(lang: Lang | string | null | undefined): SettingsNavCopy {
  return BY_LANG[normaliseLang(lang)];
}
