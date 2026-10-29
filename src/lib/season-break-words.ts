/**
 * A SEASON BREAK BY WHATSAPP (2026-10-29, Kemal: every admin feature also
 * works by tagging MatchTime). An organiser says "no football in December"
 * or "we're back mid January" (tagged in either group, or by DM); the admin
 * extractor (the model) reads the months, as "YYYY-MM", into
 * `breakMonths` (no football) and `playMonths` (back on). This sets agent
 * A's season-break months (`setSeasonBreak`, the one writer the months page
 * uses too) and says what changed, in the club's language.
 *
 * Organisers only; the callers check, as for every admin action.
 */
import { db } from "./db";
import { t } from "./i18n/t";
import { monthNameLabel } from "./i18n/dates";
import { appUrl } from "./app-url";
import { londonMonthStart } from "./squad-month-rules";

export interface SeasonBreakReply {
  outcome: "season-break-set" | "season-break-unchanged" | "season-break-refused";
  replyText: string;
}

const label = (lang: string | null, m: string) => monthNameLabel(lang, new Date(`${m}-15T12:00:00.000Z`));
const join = (lang: string | null, months: string[]) => months.map((m) => label(lang, m)).join(", ");

/** PURE. The break months after the message: what was, plus the months
 *  with no football, minus the months it is back in. This month on only. */
export function nextBreakMonths(current: readonly string[], breakMonths: readonly string[], playMonths: readonly string[], now: Date): string[] {
  const from = londonMonthStart(now).slice(0, 7);
  const out = new Set(current.filter((m) => m >= from));
  for (const m of breakMonths) if (m >= from) out.add(m);
  for (const m of playMonths) out.delete(m);
  return [...out].sort();
}

export async function applySeasonBreakWords(p: {
  orgId: string;
  breakMonths: string[];
  playMonths: string[];
  lang: string | null;
  now: Date;
}): Promise<SeasonBreakReply> {
  const s = t(p.lang);
  const org = await db.organisation.findUnique({ where: { id: p.orgId }, select: { seasonBreakMonths: true } });
  const current = (org?.seasonBreakMonths ?? []).filter((m) => m >= londonMonthStart(p.now).slice(0, 7));
  const next = nextBreakMonths(current, p.breakMonths, p.playMonths, p.now);
  const added = next.filter((m) => !current.includes(m));
  const removed = current.filter((m) => !next.includes(m));
  if (added.length === 0 && removed.length === 0) {
    return {
      outcome: "season-break-unchanged",
      replyText: next.length > 0 ? s.sb_unchanged({ months: join(p.lang, next) }) : s.sb_none({ link: appUrl("/admin/months") }),
    };
  }
  const { setSeasonBreak } = await import("./squad-month");
  const r = await setSeasonBreak(p.orgId, next, p.now);
  if (!r.ok) {
    return {
      outcome: "season-break-refused",
      replyText: r.error === "month-exists" && r.month ? s.sb_started({ month: label(p.lang, r.month) }) : s.sb_failed({ link: appUrl("/admin/months") }),
    };
  }
  const lines: string[] = [];
  if (added.length > 0) lines.push(s.sb_set({ months: join(p.lang, added) }));
  if (removed.length > 0) lines.push(s.sb_back({ months: join(p.lang, removed) }));
  return { outcome: "season-break-set", replyText: lines.join("\n") };
}
