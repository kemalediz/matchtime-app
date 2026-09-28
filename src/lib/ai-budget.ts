/**
 * THE DAILY AI SPEND CAP, PER CLUB (2026-09-29).
 *
 * Until today nothing limited what one WhatsApp group could spend on the
 * model. A group that talked to MatchTime all day, or a loop somebody
 * found, would bill without limit, and the September bill showed how
 * hard real spend is to see once it is mixed with everything else. This
 * is a HARD cap, in real dollars, per club, per London calendar day.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE RULE (`aiAllowanceUsd`, the one place it is decided)
 * ─────────────────────────────────────────────────────────────────────
 *   - a club that is not live (`whatsappBotEnabled` false, or no linked
 *     group) may spend NOTHING, and no override lifts that;
 *   - the platform owner's per-club override, `Organisation.aiDailyCapUsd`,
 *     when set;
 *   - $0.25 a day for the first 28 days from `aiWindowStartAt` (NULL means
 *     `createdAt`; the club approval flow will set it at go-live);
 *   - $1.00 a day after that. Sutton FC is long past its first four weeks.
 *
 * Spend that happens before a club exists (the in-group setup
 * conversation, the web wizard's chat analysis) is keyed on the group or
 * the user instead of an org and gets the new-club $0.25.
 *
 * "Money" is `costOf()` in `pipeline/llm.ts` applied to the usage each
 * response reports, not a count of calls.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY A RESERVATION, AND THE OVERSHOOT BOUND
 * ─────────────────────────────────────────────────────────────────────
 * The obvious design (read today's spend, call if under the cap, add the
 * cost after) lets every request that reads before any of them writes
 * through at once. The attendance engine fans its extractions out in
 * parallel, and the Pi can post two flushes for one group back to back,
 * so "at once" is the normal case, not the edge.
 *
 * So each call first HOLDS `CALL_RESERVE_USD` ($0.01) in the same
 * statement that checks the cap: one conditional upsert, which Postgres
 * serialises on the (orgId, day) row. A call is allowed only while
 * `costUsd + reservedUsd < cap`. When it returns, its REAL cost is booked
 * and its hold released in one more statement.
 *
 *   BOUND: at most cap + $0.01 + Σ max(0, cost − $0.01) over the calls
 *   that were in flight when the cap was reached.
 *
 * Typical calls cost less than the hold (router ~$0.002, extractor
 * ~$0.004), so in practice the overshoot is under one cent. The worst
 * case per in-flight call is the pipeline's 4,096-token ceiling on Sonnet
 * 5, about $0.05 each; an analyze batch fans out at most a handful.
 *
 * A process that dies mid-call leaves its hold behind. That only ever
 * makes that one day's cap stricter, and the next day is a new row.
 *
 * ─────────────────────────────────────────────────────────────────────
 * FAIL OPEN
 * ─────────────────────────────────────────────────────────────────────
 * If the usage table cannot be read or written, the call is ALLOWED and
 * the failure is logged. A database hiccup must never silence the bot.
 * The one thing that fails CLOSED is the polite "ask me tomorrow" line:
 * if we cannot claim today's one reply, we say nothing, because silence
 * is the safe side of not knowing whether we already said it.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHO OPENS A SCOPE (every model call made on a club's behalf)
 * ─────────────────────────────────────────────────────────────────────
 *   analyze route (router, extractors, composer, generic stats answer,
 *     the group DM-me answer, team generation it triggers, onboarding)
 *   dm-reply route (DM intent, DM Q&A, match availability, roster
 *     survey, payment claim, fee confirmation)
 *   bot-scheduler chase composer, squad-from-list extraction,
 *   none-bucket shadow cron, team-generation rating adjuster,
 *   onboarding enrichment, the web onboarding wizard.
 *
 * NOBODY IS MESSAGED ABOUT A CAP HIT. The row's `cappedAt`, and one info
 * event on the owner's /admin/health page, are the whole of the record.
 */
import { db } from "./db";
import { formatLondon } from "./london-time";
import { AI_CAP_ALERT_KIND, recordOpsEvent } from "./ops-alerts";
import {
  AiBudgetExceededError,
  runWithAiBudget,
  runWithDeferredAiBudget,
  type AiBudgetHold,
  type AiBudgetLedger,
} from "./ai-budget-context";

export { bindAiBudgetKey, isAiBudgetExceeded, AiBudgetExceededError } from "./ai-budget-context";
export { AI_CAP_ALERT_KIND } from "./ops-alerts";

export const DAILY_CAP_USD = 1.0;
export const NEW_CLUB_CAP_USD = 0.25;
export const NEW_CLUB_WINDOW_DAYS = 28;
/** Held per call between reserve and settle. See the bound above. */
export const CALL_RESERVE_USD = 0.01;

/** Keys for spend that happens before a club exists. */
export const onboardingGroupKey = (groupId: string): string => `onboarding-group:${groupId}`;
export const onboardingUserKey = (userId: string): string => `onboarding-user:${userId}`;
const isPseudoKey = (key: string): boolean => key.startsWith("onboarding-");

export interface AllowanceOrg {
  createdAt: Date;
  aiDailyCapUsd: number | null;
  aiWindowStartAt: Date | null;
  whatsappBotEnabled: boolean;
  whatsappGroupId: string | null;
}

/**
 * How many dollars this club may spend on the model today. `null` is
 * spend that has no club yet (onboarding). The self-join approval slice
 * extends this, and only this, when it adds a pending state.
 */
export function aiAllowanceUsd(org: AllowanceOrg | null, now: Date): number {
  if (!org) return NEW_CLUB_CAP_USD;
  if (!org.whatsappBotEnabled || !org.whatsappGroupId) return 0;
  if (org.aiDailyCapUsd !== null && org.aiDailyCapUsd !== undefined) {
    return Number.isFinite(org.aiDailyCapUsd) ? Math.max(0, org.aiDailyCapUsd) : 0;
  }
  const start = org.aiWindowStartAt ?? org.createdAt;
  const ageMs = now.getTime() - start.getTime();
  return ageMs < NEW_CLUB_WINDOW_DAYS * 24 * 60 * 60 * 1000 ? NEW_CLUB_CAP_USD : DAILY_CAP_USD;
}

/** The London calendar day `now` falls on, as YYYY-MM-DD. */
export function londonDay(now: Date): string {
  return formatLondon(now, "yyyy-MM-dd");
}

const ALLOWANCE_SELECT = {
  createdAt: true,
  aiDailyCapUsd: true,
  aiWindowStartAt: true,
  whatsappBotEnabled: true,
  whatsappGroupId: true,
} as const;

/** The cap for a key today. Throws on a database error (callers fail open). */
async function capFor(key: string, now: Date): Promise<number> {
  if (isPseudoKey(key)) return aiAllowanceUsd(null, now);
  const org = await db.organisation.findUnique({ where: { id: key }, select: ALLOWANCE_SELECT });
  // An org id that does not exist is not a club that may spend.
  return org ? aiAllowanceUsd(org, now) : 0;
}

/**
 * The first time a club is capped today: one info line on the owner's
 * /admin/health page (`OpsAlert`). Never a DM, never an email (Kemal,
 * 2026-09-28). Idempotent on the dedupe key, so a race costs nothing.
 */
async function noteFirstCapToday(key: string, day: string, cap: number | null, what: string): Promise<void> {
  const allowance = cap === null ? "its" : `its $${cap.toFixed(2)}`;
  await recordOpsEvent({
    orgId: isPseudoKey(key) ? null : key,
    kind: AI_CAP_ALERT_KIND,
    severity: "info",
    title: "AI daily cap reached",
    detail:
      `${isPseudoKey(key) ? `${key} ` : ""}reached ${allowance} AI allowance for ${day} (${what}). ` +
      `Plain IN and OUT still work; other messages get no AI answer until London midnight. ` +
      `Usage: table "OrgAiUsage".`,
    dedupeKey: `${AI_CAP_ALERT_KIND}:${key}:${day}`,
  });
}

async function recordRefusal(key: string, day: string, cap: number, label: string): Promise<void> {
  try {
    // `first`: was the club NOT yet capped today before this statement?
    // Read from a snapshot in the same statement rather than by comparing
    // `cappedAt` to now(), which the column's millisecond precision rounds.
    const rows = await db.$queryRaw<Array<{ first: boolean }>>`
      WITH prev AS (
        SELECT "cappedAt" FROM "OrgAiUsage" WHERE "orgId" = ${key} AND "day" = ${day}::date
      )
      INSERT INTO "OrgAiUsage" ("orgId", "day", "capUsd", "refusedCalls", "cappedAt", "updatedAt")
      VALUES (${key}, ${day}::date, ${cap}, 1, now(), now())
      ON CONFLICT ("orgId", "day") DO UPDATE SET
        "refusedCalls" = "OrgAiUsage"."refusedCalls" + 1,
        "cappedAt" = COALESCE("OrgAiUsage"."cappedAt", now()),
        "capUsd" = EXCLUDED."capUsd",
        "updatedAt" = now()
      RETURNING ((SELECT "cappedAt" FROM prev) IS NULL) AS "first"`;
    if (rows[0]?.first) await noteFirstCapToday(key, day, cap, `first refused call: ${label}`);
  } catch (err) {
    console.error(`[ai-budget] could not record a refused call for ${key}:`, err);
  }
}

/**
 * The Postgres ledger. One instance per scope; it caches each key's cap
 * for the life of the scope (one request), which is the only read it
 * makes besides the reservation itself.
 */
export function prismaAiBudgetLedger(clock: () => Date = () => new Date()): AiBudgetLedger {
  const caps = new Map<string, number>();
  return {
    async reserve(key, label): Promise<AiBudgetHold> {
      const now = clock();
      const day = londonDay(now);
      let cap: number;
      try {
        cap = caps.get(key) ?? (await capFor(key, now));
        caps.set(key, cap);
      } catch (err) {
        console.error(`[ai-budget] could not read the cap for ${key}; allowing ${label} (fail open):`, err);
        return { key, day, reservedUsd: 0 };
      }
      if (cap <= 0) {
        await recordRefusal(key, day, cap, label);
        throw new AiBudgetExceededError(key, label);
      }
      let granted: boolean;
      try {
        // ONE statement: create today's row holding the reserve, or add
        // the reserve to it only while spend plus holds is under the cap.
        const rows = await db.$queryRaw<Array<{ ok: number }>>`
          INSERT INTO "OrgAiUsage" ("orgId", "day", "capUsd", "reservedUsd", "updatedAt")
          VALUES (${key}, ${day}::date, ${cap}, ${CALL_RESERVE_USD}, now())
          ON CONFLICT ("orgId", "day") DO UPDATE SET
            "reservedUsd" = "OrgAiUsage"."reservedUsd" + ${CALL_RESERVE_USD},
            "capUsd" = EXCLUDED."capUsd",
            "updatedAt" = now()
          WHERE "OrgAiUsage"."costUsd" + "OrgAiUsage"."reservedUsd" < ${cap}
          RETURNING 1 AS "ok"`;
        granted = rows.length > 0;
      } catch (err) {
        console.error(`[ai-budget] could not reserve for ${key}; allowing ${label} (fail open):`, err);
        return { key, day, reservedUsd: 0 };
      }
      if (!granted) {
        await recordRefusal(key, day, cap, label);
        throw new AiBudgetExceededError(key, label);
      }
      return { key, day, reservedUsd: CALL_RESERVE_USD };
    },

    async settle(hold, costUsd): Promise<void> {
      try {
        await db.$executeRaw`
          INSERT INTO "OrgAiUsage" ("orgId", "day", "costUsd", "calls", "updatedAt")
          VALUES (${hold.key}, ${hold.day}::date, ${costUsd}, 1, now())
          ON CONFLICT ("orgId", "day") DO UPDATE SET
            "costUsd" = "OrgAiUsage"."costUsd" + ${costUsd},
            "reservedUsd" = GREATEST(0, "OrgAiUsage"."reservedUsd" - ${hold.reservedUsd}),
            "calls" = "OrgAiUsage"."calls" + 1,
            "updatedAt" = now()`;
      } catch (err) {
        console.error(`[ai-budget] could not book $${costUsd.toFixed(5)} for ${hold.key}:`, err);
      }
    },

    async release(hold): Promise<void> {
      if (hold.reservedUsd <= 0) return;
      try {
        await db.$executeRaw`
          UPDATE "OrgAiUsage"
          SET "reservedUsd" = GREATEST(0, "reservedUsd" - ${hold.reservedUsd}), "updatedAt" = now()
          WHERE "orgId" = ${hold.key} AND "day" = ${hold.day}::date`;
      } catch (err) {
        console.error(`[ai-budget] could not release a hold for ${hold.key}:`, err);
      }
    },
  };
}

/** Run `fn` with every model call inside it spending from `key`'s cap. */
export function withOrgAiBudget<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return runWithAiBudget(key, prismaAiBudgetLedger(), fn);
}

/** Run `fn` in a scope whose club is named later with `bindAiBudgetKey`. */
export function withDeferredOrgAiBudget<T>(fn: () => Promise<T>): Promise<T> {
  return runWithDeferredAiBudget(prismaAiBudgetLedger(), fn);
}

export interface AiBudgetStatus {
  capped: boolean;
  spentUsd: number;
  capUsd: number;
  /** True when the state could not be read and `capped` is the fail-open
   *  default rather than a fact. */
  failedOpen?: boolean;
}

/**
 * Is this club at its cap right now? For the analyze route's up-front
 * decision to run the whole batch deterministically. Fails open.
 */
export async function getAiBudgetStatus(key: string, now: Date = new Date()): Promise<AiBudgetStatus> {
  try {
    const cap = await capFor(key, now);
    const rows = await db.$queryRaw<Array<{ costUsd: number; reservedUsd: number }>>`
      SELECT "costUsd", "reservedUsd" FROM "OrgAiUsage"
      WHERE "orgId" = ${key} AND "day" = ${londonDay(now)}::date`;
    const spent = Number(rows[0]?.costUsd ?? 0);
    const held = Number(rows[0]?.reservedUsd ?? 0);
    return { capped: cap <= 0 || spent + held >= cap, spentUsd: spent, capUsd: cap };
  } catch (err) {
    console.error(`[ai-budget] could not read today's usage for ${key}; treating as under the cap:`, err);
    return { capped: false, spentUsd: 0, capUsd: DAILY_CAP_USD, failedOpen: true };
  }
}

/** Count group messages that got no AI handling because of the cap. */
export async function recordCapSkips(
  key: string,
  count: number,
  now: Date = new Date(),
  capUsd: number | null = null,
): Promise<void> {
  if (count <= 0) return;
  const day = londonDay(now);
  try {
    // `cappedAt` is set here too: a club whose last allowed call carried
    // it over the cap is capped from the next batch on without a single
    // call ever being refused.
    const rows = await db.$queryRaw<Array<{ first: boolean }>>`
      WITH prev AS (
        SELECT "cappedAt" FROM "OrgAiUsage" WHERE "orgId" = ${key} AND "day" = ${day}::date
      )
      INSERT INTO "OrgAiUsage" ("orgId", "day", "skippedMessages", "cappedAt", "updatedAt")
      VALUES (${key}, ${day}::date, ${count}, now(), now())
      ON CONFLICT ("orgId", "day") DO UPDATE SET
        "skippedMessages" = "OrgAiUsage"."skippedMessages" + ${count},
        "cappedAt" = COALESCE("OrgAiUsage"."cappedAt", now()),
        "updatedAt" = now()
      RETURNING ((SELECT "cappedAt" FROM prev) IS NULL) AS "first"`;
    if (rows[0]?.first) await noteFirstCapToday(key, day, capUsd, `${count} group message(s) not handled`);
  } catch (err) {
    console.error(`[ai-budget] could not count ${count} skipped message(s) for ${key}:`, err);
  }
}

/**
 * Claim today's ONE "ask me tomorrow" line for this club. True exactly
 * once per club per London day, however many requests race for it.
 * Throws on a database error; `pickCapReplyMessage` turns that into
 * silence.
 */
export async function claimCapReply(key: string, now: Date = new Date()): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ ok: number }>>`
    INSERT INTO "OrgAiUsage" ("orgId", "day", "capReplySentAt", "updatedAt")
    VALUES (${key}, ${londonDay(now)}::date, now(), now())
    ON CONFLICT ("orgId", "day") DO UPDATE SET
      "capReplySentAt" = now(),
      "updatedAt" = now()
    WHERE "OrgAiUsage"."capReplySentAt" IS NULL
    RETURNING 1 AS "ok"`;
  return rows.length > 0;
}

/**
 * Which message, if any, gets the one polite line. Only a message that
 * TAGS MatchTime ever gets it, and the day's line is claimed only when
 * there is such a message, so a batch of banter cannot use it up. A
 * failed claim is silence.
 */
export async function pickCapReplyMessage(
  messages: Array<{ waMessageId: string; tagged: boolean }>,
  claim: () => Promise<boolean>,
): Promise<string | null> {
  const first = messages.find((m) => m.tagged);
  if (!first) return null;
  try {
    return (await claim()) ? first.waMessageId : null;
  } catch (err) {
    console.error("[ai-budget] could not claim today's cap reply; saying nothing:", err);
    return null;
  }
}
