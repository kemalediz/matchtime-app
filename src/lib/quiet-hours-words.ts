/**
 * QUIET HOURS BY WHATSAPP (2026-10-31, Kemal: every admin feature also
 * works by tagging MatchTime). MT Test, 31 Oct: "@Match Time turn off quiet
 * hours now" was read `other` and got "I can't change that by message".
 *
 * The admin extractor (the model) reads the words into `quiet_hours` facts:
 * `quietOff` (switch them off), and the London times said, `quietFrom` and
 * `quietTo` ("HH:MM"). This turns those facts into the settings page's
 * input and saves it through the one core (`saveQuietHours`), so held
 * messages are released exactly as the page releases them. Then it says
 * what was set, in the club's language.
 *
 * Organisers only, with a real tag: the callers check, as for every admin
 * action (`admin-ops-engine-batch.ts`, `admin-group-understand.ts`).
 */
import { db } from "./db";
import { appUrl } from "./app-url";
import { QUIET_HOURS_SELECT, normaliseQuietTime, quietHoursOf, type QuietHours } from "./message-hours";
import { saveQuietHours, type QuietHoursInput } from "./quiet-hours-save";
import { quietHoursWordsCopy } from "./i18n/quiet-hours-words";

export interface QuietHoursWords {
  /** Switch quiet hours off. */
  off: boolean;
  /** The start said, as the model wrote it ("22:00"), or null when not said. */
  from: string | null;
  /** The end said, or null when not said. */
  to: string | null;
}

export interface QuietHoursReply {
  outcome: "quiet-hours-off" | "quiet-hours-on" | "quiet-hours-unchanged" | "quiet-hours-refused";
  replyText: string;
}

/**
 * PURE. What the words ask for, as the settings page's input: off is off;
 * on (or new times) keeps any time not said at its saved value, as
 * switching on again on the page restores the saved times.
 */
export function quietHoursAsked(current: QuietHours, words: QuietHoursWords): QuietHoursInput {
  if (words.off) return { enabled: false };
  // "8:00" is "08:00"; a time that is not one is passed on as written, so
  // the core refuses it ("bad-time") rather than a saved time standing in.
  const time = (v: string | null, saved: string) => (v === null ? saved : (normaliseQuietTime(v) ?? v));
  return { enabled: true, from: time(words.from, current.from), to: time(words.to, current.to) };
}

export async function applyQuietHoursWords(p: QuietHoursWords & { orgId: string; lang: string | null; now: Date }): Promise<QuietHoursReply> {
  const c = quietHoursWordsCopy(p.lang);
  const url = appUrl("/admin/settings#quiet-hours");
  const current = quietHoursOf(await db.organisation.findUnique({ where: { id: p.orgId }, select: QUIET_HOURS_SELECT }));
  const input = quietHoursAsked(current, p);
  if (!input.enabled && !current.enabled) return { outcome: "quiet-hours-unchanged", replyText: c.alreadyOff };
  if (input.enabled && current.enabled && input.from === current.from && input.to === current.to) {
    return { outcome: "quiet-hours-unchanged", replyText: c.alreadyOn({ from: current.from, to: current.to }) };
  }
  const r = await saveQuietHours({ orgId: p.orgId, input, now: p.now });
  if (!r.ok) return { outcome: "quiet-hours-refused", replyText: r.error === "same-time" ? c.sameTime({ url }) : c.badTime({ url }) };
  console.log(`[quiet-hours] org=${p.orgId} set by WhatsApp: ${r.value.enabled ? `on ${r.value.from}-${r.value.to}` : "off"}, ${r.released} released`);
  return r.value.enabled
    ? { outcome: "quiet-hours-on", replyText: c.on({ from: r.value.from, to: r.value.to, released: r.released }) }
    : { outcome: "quiet-hours-off", replyText: c.off({ released: r.released }) };
}
