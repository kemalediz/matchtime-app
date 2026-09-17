/**
 * "NEVER SILENTLY DROP AN ATTENDANCE MESSAGE" — the group half.
 *
 * When somebody types IN or OUT and the server cannot work out who they
 * are, the honest thing is to say so in the group rather than let the
 * message die leaving only an `AnalyzedMessage` row. This module decides
 * whether to say it, what to say, and under what key it is deduped. The
 * database half (look up the key, write the key) stays with the caller.
 *
 * ── WHY IT IS A MODULE (2026-09-09) ──────────────────────────────────
 *
 * The 2026-08-30 independent audit found this guard gated on the one
 * field that the failure it guards against destroys:
 *
 *   "if (!sender.userId && attendanceRelevant && nextMatchForReply &&
 *        (msg.authorName ?? '').trim().length >= 1)
 *    With authorName === null the length is 0. THE ONE MECHANISM WRITTEN
 *    FOR THIS EXACT FAILURE CLASS IS GATED ON THE VERY FIELD THAT
 *    DEGRADATION DESTROYS."
 *
 * A sender arrives with no phone (every @lid privacy member does, by
 * construction) and no name (whenever the contact lookup died). That is
 * precisely when nobody can be resolved — and precisely when this guard
 * refused to fire. The clause is gone. It lives here so the rule is
 * testable, and so the next person who wants to add a condition to it has
 * to write down what it costs.
 *
 * The nameless case needs its own copy, because `isRawDigitName("")` is
 * false and the named branch would have posted "from **" into a customer's
 * group.
 */

/** Strip case and accents so two spellings of one pushname share a key. */
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";
function normKey(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * True when a "name" is really a raw phone number / numeric @lid id.
 * Duplicated deliberately from `resolve-sender.ts` rather than imported:
 * that module reaches the database, and this one must stay pure so the
 * copy rules can be tested without one.
 */
function isRawDigitName(raw: string): boolean {
  const cleaned = raw
    .trim()
    .replace(/@?lid$/i, "")
    .replace(/[@\s+().-]/g, "");
  return /^\d{5,}$/.test(cleaned);
}

export interface UnresolvedNudgePlan {
  /** False means "not this message's business" — the caller keeps its reply. */
  applies: boolean;
  /** `SentNotification.key`. Null when `applies` is false. */
  dedupeKey: string | null;
  /** What to post, before the caller checks the dedupe key. */
  reply: string | null;
}

const NOT_APPLICABLE: UnresolvedNudgePlan = { applies: false, dedupeKey: null, reply: null };

export function planUnresolvedNudge(args: {
  senderResolved: boolean;
  attendanceRelevant: boolean;
  matchId: string | null;
  authorName: string | null;
  dropping: boolean;
  /** The group's language; English when absent. */
  lang?: Lang | string | null;
}): UnresolvedNudgePlan {
  const { senderResolved, attendanceRelevant, matchId, authorName, dropping } = args;
  // Three guards, and the name is deliberately NOT one of them. A resolved
  // sender needs nothing, banter needs nothing, and with no match there is
  // nothing to talk about — but "we could not read who this was" is the
  // whole reason to speak up, not a reason to stay quiet.
  if (senderResolved || !attendanceRelevant || !matchId) return NOT_APPLICABLE;

  const pushname = (authorName ?? "").trim();
  // A bare @lid rendered as digits is not a name: it can never match the
  // roster and must never be printed in the group. Treated exactly like no
  // name at all, which is what it is.
  const anonymous = pushname.length === 0 || isRawDigitName(pushname);

  // All anonymous senders on a match share ONE key. There is nothing to
  // key on, and a key per message would post the same sentence once per
  // unattributable message in a batch — the group spam that gets a bot
  // muted, which is the same silence the nudge exists to prevent.
  const dedupeKey = anonymous
    ? `unresolved-sender:${matchId}:unknown`
    : `unresolved-sender:${matchId}:${normKey(pushname)}`;

  // Plain English — describe what to DO next, no "resolver"/"@lid"/
  // "pushname" jargon (per the product copy rule).
  const verb = dropping ? "drop out" : "join";
  const s = t(args.lang);
  const reply = anonymous
    ? s.unresolved_nudge_anonymous({ verb })
    : s.unresolved_nudge_named({ verb, pushname });

  return { applies: true, dedupeKey, reply };
}
