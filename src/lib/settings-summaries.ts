/**
 * THE ONE-LINE SUMMARY OF EACH COLLAPSED CARD on /admin/settings
 * (2026-10-28), e.g. "Player pool: On, automatic asking off". Pure: data
 * the page (or the card itself) has already loaded in, one line of the
 * club's language out. Unit tested in `__tests__/settings-summaries.test.ts`.
 */
import { FEATURE_META, type ToggleableKey } from "./org-features-meta";
import { settingsNavCopy } from "./i18n/settings-nav";
import { t } from "./i18n/t";
import { LANG_LABELS, normaliseLang, type Lang } from "./i18n/lang";

type L = Lang | string | null | undefined;

/** A switch's label as the settings page writes it, in the club's language. */
function featureLabel(lang: L, key: ToggleableKey): string {
  const s = t(lang);
  if (key === "badgeAnnouncements") return s.badges_feature_label;
  if (key === "gearReminder") return s.gear_feature_label;
  const english = (FEATURE_META.find((m) => m.key === key)?.label ?? key).replace(/^\s*↳\s*/, "");
  return s.onbFeatureLabel({ key, englishLabel: english });
}

/** "Label: on, Label: off". */
function switches(lang: L, items: Array<[label: string, on: boolean]>): string {
  const c = settingsNavCopy(lang);
  return items.map(([label, on]) => `${label}: ${on ? c.onInList : c.offInList}`).join(", ");
}

export function onOffSummary(lang: L, on: boolean): string {
  const c = settingsNavCopy(lang);
  return on ? c.on : c.off;
}

export function clubDetailsSummary(lang: L, a: { name: string; memberCount: number }): string {
  return `${a.name}, ${settingsNavCopy(lang).summary.members(a.memberCount)}`;
}

export function languageSummary(code: L): string {
  return LANG_LABELS[normaliseLang(code)];
}

export function whatsappSummary(lang: L, a: { enabled: boolean; settingUp?: boolean; removed?: boolean }): string {
  const s = t(lang);
  if (a.settingUp) return a.removed ? s.sj_live_wa_badge_removed : s.sj_live_wa_badge;
  return a.enabled ? settingsNavCopy(lang).summary.whatsappOn : settingsNavCopy(lang).off;
}

/** `rollingSquad` null: a monthly club, which has no rolling squad. */
export function weeklyRoutineSummary(lang: L, a: { rollingSquad: boolean | null; deadlines: number }): string {
  const c = settingsNavCopy(lang);
  const deadlines = c.summary.weeklyDeadlines(a.deadlines);
  if (a.rollingSquad === null) return deadlines.charAt(0).toUpperCase() + deadlines.slice(1);
  return `${switches(lang, [[t(lang).wr_rolling_label, a.rollingSquad]])}, ${deadlines}`;
}

export function remindersSummary(lang: L, a: { personal: boolean; gear: boolean }): string {
  return switches(lang, [
    [featureLabel(lang, "reminders"), a.personal],
    [featureLabel(lang, "gearReminder"), a.gear],
  ]);
}

export function teamsSummary(lang: L, a: { balancing: boolean; first: string; second: string }): string {
  return `${switches(lang, [[featureLabel(lang, "teamBalancing"), a.balancing]])}, ${settingsNavCopy(lang).summary.teamsBoth(a.first, a.second)}`;
}

export function monthlySquadSummary(lang: L, mode: "weekly" | "monthly"): string {
  const c = settingsNavCopy(lang).summary;
  return mode === "monthly" ? c.monthlySquad : c.weeklySquad;
}

export function benchSummary(lang: L, a: { on: boolean; pickMode: "first-come" | "organiser" }): string {
  const c = settingsNavCopy(lang);
  if (!a.on) return c.off;
  return `${c.on}, ${a.pickMode === "organiser" ? c.summary.benchOrganiser : c.summary.benchFirstCome}`;
}

export function ratingsSummary(lang: L, a: { ratings: boolean; badges: boolean; stats: boolean }): string {
  return switches(lang, [
    [featureLabel(lang, "playerRating"), a.ratings],
    [featureLabel(lang, "badgeAnnouncements"), a.badges],
    [featureLabel(lang, "statsQa"), a.stats],
  ]);
}

export function momSummary(lang: L, a: { on: boolean; chosenBy: "players" | "organisers" }): string {
  const c = settingsNavCopy(lang);
  if (!a.on) return c.off;
  return `${c.on}, ${a.chosenBy === "organisers" ? c.summary.momOrganisers : c.summary.momPlayers}`;
}

export function inviteLinkSummary(lang: L): string {
  return settingsNavCopy(lang).summary.inviteLink;
}

export function paymentsSummary(lang: L, a: { collecting: boolean; bankConnected: boolean }): string {
  const c = settingsNavCopy(lang).summary;
  if (!a.collecting) return c.paymentsOff;
  return a.bankConnected ? c.paymentsBank : c.paymentsNoBank;
}

/** The billing card's words come from the server in the club's language. */
export function billingSummary(a: { lines: string[]; month?: string | null }): string {
  return a.month || a.lines[0] || "";
}

export function partnerClubsSummary(lang: L, a: { partners: number; requestsWaiting: number }): string {
  const c = settingsNavCopy(lang).summary;
  const head = a.partners === 0 ? c.partnersNone : c.partners(a.partners);
  return a.requestsWaiting > 0 ? `${head}, ${c.partnerRequests(a.requestsWaiting)}` : head;
}

/** `autoAsk` null until its card has loaded. */
export function playerPoolSummary(lang: L, a: { on: boolean; autoAsk: boolean | null }): string {
  const c = settingsNavCopy(lang);
  if (!a.on) return c.off;
  if (a.autoAsk === null) return c.on;
  return `${c.on}, ${c.summary.poolAutoAsk} ${a.autoAsk ? c.onInList : c.offInList}`;
}

/** `label`: the chosen style in the club's language; null when none is. */
export function playStyleSummary(lang: L, label: string | null): string {
  return label ?? settingsNavCopy(lang).summary.playStyleNotSet;
}

export function clubShareSummary(lang: L, a: { kind: "ready" | "no-group" | "queued" | "sent"; statusLine: string | null }): string {
  const c = settingsNavCopy(lang).summary;
  if (a.kind === "ready") return c.clubShareReady;
  if (a.kind === "no-group") return c.clubShareNoGroup;
  return a.statusLine ?? "";
}

export function groupInviteLinkSummary(lang: L, mode: "bot" | "pasted" | "none"): string {
  const c = settingsNavCopy(lang).summary;
  return mode === "bot" ? c.inviteLinkBot : mode === "pasted" ? c.inviteLinkPasted : c.inviteLinkNone;
}

export function quietHoursSummary(lang: L, a: { enabled: boolean; from: string; to: string }): string {
  const c = settingsNavCopy(lang);
  return a.enabled ? c.summary.quietHoursOn(a.from, a.to) : c.off;
}

export function adminGroupSummary(lang: L, a: { mode: "one-person" | "admin-group" | "each-admin"; group: string | null }): string {
  const c = settingsNavCopy(lang).summary;
  if (a.mode === "admin-group") return a.group ? c.adminGroupLinked(a.group) : c.adminGroupNotLinked;
  return a.mode === "each-admin" ? c.adminEachAdmin : c.adminOnePerson;
}

/** The poster design in use, by its name in the gallery. */
export function postersSummary(options: Array<{ id: string; name: string }>, current: string): string | null {
  return options.find((o) => o.id === current)?.name ?? null;
}
