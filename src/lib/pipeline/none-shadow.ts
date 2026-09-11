/**
 * §11.1's FOURTH CONTAINMENT — "shadow the `none` bucket forever".
 *
 *   "Sample `none`-routed messages through the full extractor nightly,
 *    offline, and alert on any that produce a claim. This is the
 *    regression detector the current architecture has never had."
 *
 * The gate's failure mode is silent by construction: a message routed
 * `none` produces no write, no reply and no reaction, so nothing about
 * it looks wrong. The only way to find out it was wrong is to go back
 * and ask a better model. That is what this does, once a night, on a
 * sample, offline, with the answer written where a human can read it.
 *
 * NOTHING HERE WRITES TO THE SQUAD. No attendance, no BotJob, no
 * message. Its only output is one `WindowVerdict` row PER ORG PER NIGHT
 * (the table the shadow harness and `/admin/shadow` already use) and a
 * `console.error` per alert.
 *
 * ⚠️ THE ROW IS FILED WHETHER OR NOT ANYTHING WAS FOUND (2026-09-11).
 * It was filed only when `result.alerts[0]` existed, and the cost of
 * that was measured: ONE row in the sweep's entire life, 1 of 506
 * `WindowVerdict` rows, on 2026-09-09 (§1.4 of
 * `MDs/router-accuracy-2026-09-11.md`). A clean night, a crashed cron, a
 * revoked API key and a job nobody ever scheduled all left the same
 * evidence — none — which is the failure class
 * `MDs/SESSION-HANDOFF-2026-09-09.md` names as "the thing that actually
 * matters: nothing was watching", reappearing inside the fix for it.
 * `lib/bot-health.ts` now treats a MISSING row as a degradation, so the
 * row is the heartbeat and filing it is not optional.
 *
 * An alert is a message for a person to look at, not an action for the
 * bot to take: acting on a day-old attendance claim would be worse than
 * missing it, because the squad has moved on.
 *
 * Behind `NONE_BUCKET_SHADOW_ENABLED`, default OFF. A nightly job that
 * spends money must be something someone turned on deliberately.
 *
 * ⚠️ THE OFF POSITION GOT MORE EXPENSIVE ON 2026-09-06. This used to add
 * that the flag was "separately from the gate. With the gate off there
 * is nothing tagged `router-gate` to look at anyway, so the flag is belt
 * and braces". `ROUTER_GATE_ENABLED` is DELETED (§10 step 8 — `gate.ts`
 * carries the argument) and the router now always runs, so there is
 * always a `router-gate` bucket to look at. And it is no longer belt and
 * braces: the same change deleted `analyzeBatch`, the 19,850-token
 * `SYSTEM_PROMPT` and `executeVerdict`, so a message the router calls
 * `none` is read by NO second decider. §11.1 calls this sweep "the
 * regression detector the current architecture has never had"; it is now
 * the ONLY remaining thing that ever looks at a `none` again, and the
 * only way a real IN routed as banter is ever found.
 */
import { extractorStubFromEnv } from "./extractor-stub";
import { extractForRoute } from "./extractors";
import { GATED_HANDLED_BY, isNoneBucketShadowEnabled } from "./gate";
import { anthropicModel, type PipelineModel } from "./llm";
import type { Claim, Facts } from "./types";

/** The route the sample is re-examined under. `unsure` is deliberate:
 *  it maps to the ATTENDANCE extractor (`extractorFor`), which is the
 *  one that can produce a claim about a squad place — the only kind of
 *  miss worth waking anyone for. */
const REEXAMINE_AS = "unsure" as const;

/** A nightly job on a club with ~13 analyzed messages a day does not
 *  need to re-examine thousands. The cap exists so a backlog (or a
 *  misconfigured lookback) cannot turn into a surprise bill. */
export const DEFAULT_SAMPLE = 40;
export const DEFAULT_LOOKBACK_HOURS = 24;

/**
 * The prefix every row this sweep files carries in `WindowVerdict.
 * batchHash`, and the ONLY handle anything else has on those rows.
 *
 * Exported because `lib/bot-health.ts` now alerts when no row with this
 * prefix has appeared inside the expected window, and two spellings of
 * `"none-bucket:"` in two files is precisely how a watcher silently
 * stops watching. One constant, one grep.
 */
export const NONE_SHADOW_BATCH_PREFIX = "none-bucket:";

/** One row per org per UTC day the sweep runs. The day comes from the
 *  sweep's own clock rather than `new Date()` at the call site, so a
 *  re-run with `?force=1` lands on the same key and updates the day's
 *  row instead of filing a second one. */
export function noneShadowBatchHash(now: Date): string {
  return `${NONE_SHADOW_BATCH_PREFIX}${now.toISOString().slice(0, 10)}`;
}

export interface NoneBucketRow {
  waMessageId: string;
  orgId: string;
  authorName: string | null;
  body: string | null;
  createdAt: Date;
}

export interface NoneBucketAlert {
  waMessageId: string;
  orgId: string;
  authorName: string | null;
  body: string;
  createdAt: string;
  claims: Claim[];
}

/**
 * What the sweep did FOR ONE ORG, which is the unit a filed row and an
 * alert are both scoped to.
 *
 * The sweep's query is deliberately global (one `findMany` over the
 * whole gated bucket, one shared sample cap), because the money it
 * spends is a property of the night and not of any one club. But a
 * `WindowVerdict` row belongs to an org, and `bot-health` reasons one
 * org at a time, so the result has to be able to say which org each
 * message it read came from — including, and especially, on a night
 * where nothing alerted.
 */
export interface NoneBucketOrgCoverage {
  orgId: string;
  /** Gated rows this org had in the window, before sampling. */
  available: number;
  /** How many of them were re-examined. */
  checked: number;
  /** How many produced an attendance claim. */
  alerts: number;
  costUsd: number;
  ms: number;
}

export interface NoneBucketResult {
  enabled: boolean;
  /** Rows the sweep looked at. */
  checked: number;
  /** Rows available before sampling — so a report can say what it did
   *  not look at, rather than implying it looked at everything. */
  available: number;
  /** The window swept, recorded so a filed row states what it covered
   *  rather than leaving the reader to assume the default lookback. */
  windowStart: Date;
  windowEnd: Date;
  /** Per-org coverage, in first-seen order. EMPTY on a night with no
   *  gated traffic at all — which is a real answer, not a missing one. */
  byOrg: NoneBucketOrgCoverage[];
  alerts: NoneBucketAlert[];
  costUsd: number;
  ms: number;
  errors: string[];
}

/**
 * PURE. Deterministic, evenly-spread sample.
 *
 * Not `slice(0, n)`: the gate skips whole banter bursts at once, and
 * taking the first N would re-examine one evening's group chat and call
 * it a night's coverage. Striding across the window samples every part
 * of the day. Deterministic so two runs over the same backlog look at
 * the same messages and a fix can be verified.
 */
export function sampleNoneBucket<T>(rows: T[], limit: number): T[] {
  if (limit <= 0) return [];
  if (rows.length <= limit) return [...rows];
  const stride = rows.length / limit;
  const out: T[] = [];
  for (let i = 0; i < limit; i++) out.push(rows[Math.floor(i * stride)]);
  return out;
}

/** Does this extraction say a squad place was at stake? */
export function claimsOf(facts: Facts): Claim[] {
  return facts.kind === "attendance" ? facts.claims : [];
}

export interface NoneBucketDb {
  analyzedMessage: {
    findMany(args: unknown): Promise<NoneBucketRow[]>;
  };
}

export interface NoneBucketOptions {
  db: NoneBucketDb;
  now?: Date;
  lookbackHours?: number;
  limit?: number;
  model?: PipelineModel;
  /** Bypasses the flag. Used by the tests, and by an operator running
   *  the sweep by hand from the cron route with `?force=1`. */
  force?: boolean;
}

export async function runNoneBucketShadow(
  opts: NoneBucketOptions,
): Promise<NoneBucketResult> {
  // Hoisted above the flag check: even the "not enabled" result names the
  // window it would have covered, so a caller never has to guess which
  // 24 hours a zero refers to.
  const now = opts.now ?? new Date();
  const since = new Date(
    now.getTime() - (opts.lookbackHours ?? DEFAULT_LOOKBACK_HOURS) * 3_600_000,
  );
  const empty = (enabled: boolean): NoneBucketResult => ({
    enabled,
    checked: 0,
    available: 0,
    windowStart: since,
    windowEnd: now,
    byOrg: [],
    alerts: [],
    costUsd: 0,
    ms: 0,
    errors: [],
  });
  if (!opts.force && !isNoneBucketShadowEnabled()) return empty(false);

  const limit = opts.limit ?? DEFAULT_SAMPLE;

  const rows = await opts.db.analyzedMessage.findMany({
    where: { handledBy: GATED_HANDLED_BY, createdAt: { gte: since } },
    select: { waMessageId: true, orgId: true, authorName: true, body: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const withBody = rows.filter((r) => (r.body ?? "").trim().length > 0);
  const sample = sampleNoneBucket(withBody, limit);
  // `extractorStubFromEnv()` first, exactly as `answer-batch.ts` does.
  // It is null unless MT_TEST_EXTRACTOR_STUB_FILE is set, which is never
  // in production — and without it the nightly sweep is a path the free
  // e2e suite cannot drive at all, which is how it went five nights
  // without anybody noticing it had filed nothing.
  const model = opts.model ?? extractorStubFromEnv() ?? anthropicModel();

  const result = empty(true);
  result.available = withBody.length;
  const t0 = Date.now();

  // Per-org coverage, in first-seen order. Seeded from EVERY gated row,
  // not only the sampled ones, so `available` per org is the truth about
  // the window rather than the truth about the sample.
  const byOrg = new Map<string, NoneBucketOrgCoverage>();
  const coverage = (orgId: string): NoneBucketOrgCoverage => {
    let c = byOrg.get(orgId);
    if (!c) {
      c = { orgId, available: 0, checked: 0, alerts: 0, costUsd: 0, ms: 0 };
      byOrg.set(orgId, c);
    }
    return c;
  };
  for (const row of withBody) coverage(row.orgId).available += 1;

  for (const row of sample) {
    result.checked += 1;
    const org = coverage(row.orgId);
    org.checked += 1;
    const rowStart = Date.now();
    const res = await extractForRoute(model, REEXAMINE_AS, {
      id: row.waMessageId,
      body: row.body ?? "",
      authorName: row.authorName,
      // The sweep has no record of whether the bot was tagged, and
      // guessing would change the extractor's reading. `false` is the
      // conservative choice: an untagged message is the harder case, so
      // a claim found here is a claim that would have been found anyway.
      tagged: false,
      history: [],
      lastBotPost: null,
    });
    org.ms += Date.now() - rowStart;
    result.costUsd += res.usage?.costUsd ?? 0;
    org.costUsd += res.usage?.costUsd ?? 0;
    for (const d of res.degradations) result.errors.push(`${row.waMessageId}: ${d.detail}`);
    const claims = claimsOf(res.facts);
    if (claims.length > 0) {
      org.alerts += 1;
      result.alerts.push({
        waMessageId: row.waMessageId,
        orgId: row.orgId,
        authorName: row.authorName,
        body: row.body ?? "",
        createdAt: row.createdAt.toISOString(),
        claims,
      });
    }
  }
  result.ms = Date.now() - t0;
  result.byOrg = [...byOrg.values()];

  for (const a of result.alerts) {
    console.error(
      `[none-shadow] ALERT — a message the router gate skipped produced ${a.claims.length} ` +
        `attendance claim(s) on re-examination. org=${a.orgId} msg=${a.waMessageId} ` +
        `at=${a.createdAt} body=${JSON.stringify(a.body.slice(0, 160))} ` +
        `claims=${JSON.stringify(a.claims)}`,
    );
  }
  console.log(
    `[none-shadow] re-examined ${result.checked} of ${result.available} gated message(s) ` +
      `since ${since.toISOString()}: ${result.alerts.length} alert(s), ` +
      `$${result.costUsd.toFixed(5)}, ${result.ms}ms.`,
  );

  return result;
}

/**
 * The `WindowVerdict.verdictJson` payload, in the shape `/admin/shadow`
 * already renders — so the sweep shows up on the dashboard that exists
 * rather than needing one of its own.
 *
 * Pass an `orgId` to scope it to the row being filed for that org: the
 * counts become that org's, and another club's alert can never appear in
 * it. Omit it for the whole sweep (the log line, and the tests).
 *
 * `ran: true` is the field the whole change is for. A row filed with
 * `checked: 0` says "the sweep ran and there was nothing in the bucket";
 * NO ROW says "nobody knows whether it ran". Before 2026-09-11 those two
 * states were the same absence of data, and the sweep — the only thing
 * watching for a real IN the router called banter — had filed exactly
 * one row in its life without anybody being able to tell.
 */
export function toWindowShape(
  r: NoneBucketResult,
  orgId?: string,
): Record<string, unknown> {
  const org = orgId ? r.byOrg.find((o) => o.orgId === orgId) : undefined;
  const checked = orgId ? (org?.checked ?? 0) : r.checked;
  const available = orgId ? (org?.available ?? 0) : r.available;
  const alerts = orgId ? r.alerts.filter((a) => a.orgId === orgId) : r.alerts;
  const costUsd = orgId ? (org?.costUsd ?? 0) : r.costUsd;
  return {
    windowSummary:
      `none-bucket shadow: re-examined ${checked} of ${available} gated message(s), ` +
      `${alerts.length} produced an attendance claim. $${costUsd.toFixed(5)}.`,
    // Deliberately empty: this sweep proposes NOTHING. It reports.
    stateChanges: [],
    reactions: [],
    groupReply: null,
    pipeline: "none-bucket-shadow",
    /** The sweep executed. Machine-readable, so "it ran and found
     *  nothing" survives without anybody parsing the prose above. */
    ran: true,
    checked,
    available,
    alertCount: alerts.length,
    costUsd,
    windowStart: r.windowStart.toISOString(),
    windowEnd: r.windowEnd.toISOString(),
    /** Sweep-wide totals, kept alongside the per-org figures so a single
     *  row never has to be read as if it were the whole night. */
    sweep: { checked: r.checked, available: r.available, costUsd: r.costUsd, ms: r.ms },
    alerts,
    errors: r.errors,
  };
}
