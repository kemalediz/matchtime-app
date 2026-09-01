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
 * message. Its only output is one `WindowVerdict` row (the table the
 * shadow harness and `/admin/shadow` already use) and a `console.error`
 * per alert. An alert is a message for a person to look at, not an
 * action for the bot to take: acting on a day-old attendance claim would
 * be worse than missing it, because the squad has moved on.
 *
 * Behind `NONE_BUCKET_SHADOW_ENABLED`, default OFF, separately from the
 * gate. With the gate off there is nothing tagged `router-gate` to look
 * at anyway, so the flag is belt and braces — but a nightly job that
 * spends money must be something someone turned on deliberately.
 */
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

export interface NoneBucketResult {
  enabled: boolean;
  /** Rows the sweep looked at. */
  checked: number;
  /** Rows available before sampling — so a report can say what it did
   *  not look at, rather than implying it looked at everything. */
  available: number;
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
  const empty = (enabled: boolean): NoneBucketResult => ({
    enabled,
    checked: 0,
    available: 0,
    alerts: [],
    costUsd: 0,
    ms: 0,
    errors: [],
  });
  if (!opts.force && !isNoneBucketShadowEnabled()) return empty(false);

  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.lookbackHours ?? DEFAULT_LOOKBACK_HOURS) * 3_600_000);
  const limit = opts.limit ?? DEFAULT_SAMPLE;

  const rows = await opts.db.analyzedMessage.findMany({
    where: { handledBy: GATED_HANDLED_BY, createdAt: { gte: since } },
    select: { waMessageId: true, orgId: true, authorName: true, body: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const withBody = rows.filter((r) => (r.body ?? "").trim().length > 0);
  const sample = sampleNoneBucket(withBody, limit);
  const model = opts.model ?? anthropicModel();

  const result = empty(true);
  result.available = withBody.length;
  const t0 = Date.now();

  for (const row of sample) {
    result.checked += 1;
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
    result.costUsd += res.usage?.costUsd ?? 0;
    for (const d of res.degradations) result.errors.push(`${row.waMessageId}: ${d.detail}`);
    const claims = claimsOf(res.facts);
    if (claims.length > 0) {
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

/** The `WindowVerdict.verdictJson` payload, in the shape
 *  `/admin/shadow` already renders — so the sweep shows up on the
 *  dashboard that exists rather than needing one of its own. */
export function toWindowShape(r: NoneBucketResult): Record<string, unknown> {
  return {
    windowSummary:
      `none-bucket shadow: re-examined ${r.checked} of ${r.available} gated message(s), ` +
      `${r.alerts.length} produced an attendance claim. $${r.costUsd.toFixed(5)}.`,
    // Deliberately empty: this sweep proposes NOTHING. It reports.
    stateChanges: [],
    reactions: [],
    groupReply: null,
    pipeline: "none-bucket-shadow",
    alerts: r.alerts,
    errors: r.errors,
  };
}
