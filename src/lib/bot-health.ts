/**
 * THE SIGNAL PATH OFF THE RASPBERRY PI.
 *
 * ── Why this file exists ─────────────────────────────────────────────
 *
 * The 2026-08-30 independent audit's headline was not about the injected
 * WhatsApp layer at all:
 *
 *   "The single biggest problem is not the injected layer — it is that
 *    every failure signal is a `console.error` on a Raspberry Pi that
 *    nobody reads. There is no heartbeat, no server-side staleness check,
 *    no alert. That is why August cost three days."
 *
 * Every mitigation shipped since then routed its alarm to the same
 * unread file. `missingSendResultMessage`, `degradedMessage`, the
 * enrichment CRITICAL, the empty-flush counters, the `getChats` canary:
 * all of them write to `bot.log` on a Pi in a cupboard. Meanwhile the
 * participant sweep has been dead since 2026-07-07, an @-mention bug
 * corrupted stored names for months, and a format-switch bug had been
 * wrong at every switch since May. Each of those was found by a human
 * complaining, never by the system saying so.
 *
 * This module is the DECISION half of the fix: given counters the Pi
 * reported and timestamps the server already holds, does a human need to
 * be told, and what does the sentence say. It is pure — no database, no
 * mail, no clock of its own — because the thing that must never be wrong
 * here is the JUDGEMENT, and judgement is the part you can only pin down
 * with tests.
 *
 * The impure halves live elsewhere:
 *   - `POST /api/whatsapp/heartbeat`: the Pi's 10-minute report.
 *   - `GET  /api/cron/bot-health`: the hourly server-side sweep that
 *     notices ABSENCE, which is the half a Pi-driven heartbeat can never
 *     report, and RECORDS what it finds (`src/lib/ops-alerts.ts`).
 *
 * ── WHERE THE FINDINGS GO (2026-09-28) ───────────────────────────────
 *
 * Nowhere that buzzes. From 2026-09-09 to 2026-09-28 these findings were
 * emailed to the owner and sent to him as WhatsApp DMs, first every six
 * hours and then once a day. He read none of them, they buried the
 * messages he does need, and the last one (a quiet Sunday night reported
 * as "the WhatsApp layer is degraded") was wrong. His words: "Only put
 * them into a dashboard on the website where i can click and see
 * whenever i want."
 *
 * So the cron writes one `OpsAlert` row per condition, keeps it open
 * while the rule holds and closes it when it stops, and the owner reads
 * them at /admin/health. The scheduling, digest and collapsing logic
 * that used to live here (`planHealthAlert`, `composeHealthAlert`,
 * `trackFirstSeen`) is gone with the messages it existed to pace.
 *
 * ── THE ONE RULE THAT MATTERS MORE THAN CATCHING EVERYTHING ──────────
 *
 * A dashboard that is always red gets ignored exactly like an inbox that
 * is always full. So every threshold below is set to clear the loudest
 * HEALTHY situation it could be confused with, and the tests in
 * `__tests__/bot-health.test.ts` lead with the false-alarm cases:
 * a genuinely quiet group, a week with no fixture, a dormant club whose
 * matches keep being generated, an overnight gap, a quiet weekend before
 * a Tuesday game, an older Pi build that has never sent a heartbeat at
 * all. If a rule cannot be stated so that it is silent on all of them,
 * it does not belong here.
 */
import { GROUP_SYNC_FRESHNESS_DAYS } from "./group-membership-gate";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long the server waits for a heartbeat before calling the Pi dead.
 *
 * The Pi's batch-flush timer fires every 10 minutes and reports on every
 * tick, INCLUDING the do-nothing tick where the buffer was empty (that is
 * the whole point — an empty buffer is the failure we are hunting, so the
 * report cannot be conditional on having something to say).
 *
 * 45 minutes is four missed ticks.
 *   - 20 minutes would fire on one bad Wi-Fi moment plus one missed tick,
 *     and on a slightly slow `scripts/deploy-pi.sh` restart. A weekly
 *     false page is a muted channel.
 *   - 3 hours is too loose: the Tuesday chase runs at 17:00 for a 21:30
 *     kickoff, so a dead Pi discovered three hours later is a dead Pi
 *     discovered after the roster mattered.
 *   - 45 minutes clears every restart and blip we have observed while
 *     still leaving hours of runway before a fixture.
 */
export const HEARTBEAT_SILENT_MS = 45 * MINUTE;

/**
 * How long a LIVE group may produce no analysed message before that is
 * worth a line on the health page.
 *
 * 30 hours, and only under the guards in `inbound-silent` below.
 *
 * It was 18 hours until 2026-09-28, and on that day it fired on nothing:
 * Sutton FC's last message was Sunday 13:25, the check ran Monday 09:00
 * with the match 35 hours away, the Pi was alive and had buffered every
 * message it had been sent, and Kemal posted at 10:54. A small club goes
 * quiet from Sunday afternoon to Monday lunchtime, which 18 hours cannot
 * clear.
 *
 * MEASURED, over Sutton's last six fixtures: the longest silence inside
 * the 36 hours before kickoff was 9.7h, 15.7h and 21.5h in normal weeks.
 * The two weeks above that were real outages, 40.7 hours (14 Sep) and
 * 3.8 days (20 to 22 Sep, the Pi was down and `pi-silent` covered it).
 * 30 hours sits above every normal week with room to spare and well
 * below the smallest real outage.
 */
export const INBOUND_SILENT_MS = 30 * HOUR;

/**
 * How close a fixture has to be for silence to count as a fault.
 *
 * 36 hours. For a Tuesday 21:30 kickoff that is Monday morning onward —
 * the window in which the bot itself posts the chase and the roster, and
 * players reply. A group that is going to play tomorrow and has said
 * nothing at all for 18 hours is not quiet, it is unheard.
 *
 * Deliberately NOT a whole "match week": three days out, total silence is
 * normal in a small club and alerting on it is the false alarm that
 * teaches the reader to ignore this channel.
 */
export const MATCH_IMMINENT_MS = 36 * HOUR;

/**
 * How recently the group must have produced ANY analysed message for
 * `inbound-silent` to apply at all.
 *
 * 14 days. This is the dormant-club guard, and it exists because of a
 * real case: Sutton Lads churned in June 2026, their org was left
 * enabled-but-dormant with data retained, and the daily match generator
 * happily keeps creating fixtures for an Activity nobody plays. Without
 * this guard that org would page somebody every single day, forever, for
 * a club that no longer exists.
 */
export const GROUP_ALIVE_WINDOW_MS = 14 * DAY;

/**
 * How long the server waits for the nightly `none`-bucket shadow sweep
 * to file a row before calling it dead.
 *
 * 30 hours, against a job scheduled at 03:00 UTC daily (`vercel.json`).
 * The same argument as `HEARTBEAT_SILENT_MS`, one cadence up: the sweep
 * reports every night whether or not it found anything, so absence is
 * the only signal there is.
 *
 *   - 25 hours would fire on a cron that started late. Vercel does not
 *     promise a scheduled invocation to the minute, and a monitoring
 *     rule that trips on ordinary scheduler jitter is a muted channel.
 *   - 48 hours is two missed nights, and the second night's `none`
 *     bucket is already gone past the 24-hour lookback by then — a miss
 *     discovered after the messages have aged out is a miss discovered
 *     too late to re-read.
 *   - 30 hours clears every plausible delay and still reports a missed
 *     night by 09:00 UTC the following morning, in daylight, which is
 *     when somebody could act on it.
 *
 * Unlike every other threshold here this one guards a MONITOR rather
 * than the pipeline, so the finding is a warning: nothing about the
 * club's evening changes while it fires. What is lost is the ability to
 * find out later that the router called a real IN banter, and `gate.ts`
 * rests its entire containment argument on exactly that.
 */
export const NONE_SHADOW_SILENT_MS = 30 * HOUR;

export type HealthCode =
  | "pi-silent"
  | "seen-not-buffered"
  | "messages-dropped"
  | "synthetic-ids"
  | "enrichment-degraded"
  | "nameless-senders"
  | "reactions-failing"
  | "capability-degraded"
  | "sweep-stale"
  | "none-shadow-stale"
  | "inbound-silent";

/**
 * The Pi's per-process tallies, as of its last heartbeat.
 *
 * Cumulative since the bot process started, NOT per window. That is
 * deliberate: a delta needs two snapshots and a story about what happens
 * when the process restarts between them, and every rule below is
 * expressible as "has this EVER happened in this process", which needs
 * neither. A counter that resets on restart is also self-clearing, which
 * is the right behaviour after a fix is deployed.
 */
export interface HealthCounters {
  /** Inbound handler invocations. */
  seen: number;
  /** Of those, how many reached a group's analyse buffer. */
  buffered: number;
  /** Messages whose WhatsApp id had to be invented locally. */
  synthetic: number;
  /** Messages whose REAL id was rebuilt from the key's parts. */
  reconstructed: number;
  /** Skipped because they were not a group message. */
  notGroup: number;
  /** Enrichment calls that fell back to the raw payload. */
  degradedEnrichment: number;
  /** Buffered messages with neither a phone nor a name — unattributable. */
  nameless: number;
  /** Reactions the bot could not place. */
  reactFailures: number;
  /** Analyze POSTs that failed (and were requeued). */
  flushFailures: number;
  /** Messages given up on after the retry ceiling — permanently lost. */
  droppedMessages: number;
}

/** Every counter key, in one place, so the parser and the row agree. */
const COUNTER_KEYS = [
  "seen",
  "buffered",
  "synthetic",
  "reconstructed",
  "notGroup",
  "degradedEnrichment",
  "nameless",
  "reactFailures",
  "flushFailures",
  "droppedMessages",
] as const;

/** How many degraded-capability strings a heartbeat may carry. */
const MAX_CAPABILITIES = 20;
/** Longest capability string kept, so a stack trace cannot land in a column. */
const MAX_CAPABILITY_CHARS = 64;

export interface ParsedHeartbeat {
  groupId: string;
  processStartedAt: Date | null;
  botVersion: string | null;
  counters: HealthCounters;
  degradedCapabilities: string[];
}

function nonNegativeInt(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  const n = Math.floor(v);
  return n > 0 ? n : 0;
}

/**
 * Read a heartbeat body off the wire, TOTALLY.
 *
 * The Pi is deployed by hand and the server ships on merge, so the two
 * are routinely different builds in both directions. This parser is the
 * only place that has to survive that, and it does it by being
 * uninterested in anything it was not expecting:
 *
 *   - a NEWER Pi sending a counter this server has never heard of → the
 *     key is dropped, everything else is stored. Never a 400: a rejected
 *     heartbeat would read, to the cron, exactly like a dead Pi, and a
 *     false "the bot is down" page over a spelling difference is the
 *     noise that gets this whole channel muted.
 *   - an OLDER Pi omitting a counter → it defaults to 0, which is also
 *     what "this build does not measure that" honestly means.
 *
 * Returns null only when there is no group to attribute the report to,
 * which is the one thing that cannot be defaulted.
 */
export function parseHeartbeat(raw: unknown): ParsedHeartbeat | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  const groupId = typeof body.groupId === "string" ? body.groupId.trim() : "";
  if (!groupId) return null;

  const rawCounters =
    typeof body.counters === "object" && body.counters !== null
      ? (body.counters as Record<string, unknown>)
      : {};
  const counters = Object.fromEntries(
    COUNTER_KEYS.map((k) => [k, nonNegativeInt(rawCounters[k])]),
  ) as unknown as HealthCounters;

  let processStartedAt: Date | null = null;
  if (typeof body.processStartedAt === "string") {
    const d = new Date(body.processStartedAt);
    if (!Number.isNaN(d.getTime())) processStartedAt = d;
  }

  const caps = Array.isArray(body.degradedCapabilities) ? body.degradedCapabilities : [];
  const degradedCapabilities = caps
    .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    .map((c) => c.trim().slice(0, MAX_CAPABILITY_CHARS))
    .slice(0, MAX_CAPABILITIES);

  return {
    groupId,
    processStartedAt,
    botVersion:
      typeof body.botVersion === "string" && body.botVersion.trim()
        ? body.botVersion.trim().slice(0, 64)
        : null,
    counters,
    degradedCapabilities,
  };
}

export interface HeartbeatSnapshot {
  /** When the Pi last reported. */
  at: Date;
  /** When the reporting bot process started. Counters are per-process. */
  processStartedAt: Date | null;
  counters: HealthCounters;
  /** Capabilities the Pi itself declared degraded (see `degraded.ts`). */
  degradedCapabilities: string[];
}

export interface HealthInput {
  orgName: string;
  now: Date;
  /** `Organisation.whatsappBotEnabled`. A disabled org is never assessed. */
  botEnabled: boolean;
  /** The org's latest heartbeat, or null when none has ever arrived. */
  heartbeat: HeartbeatSnapshot | null;
  /** MAX(`AnalyzedMessage.createdAt`) for this org. */
  lastAnalyzedMessageAt: Date | null;
  /** `Organisation.lastParticipantSweepAt` — the sweep's own clock, whose
   *  only writer is `importParticipants`. It was MAX(`Membership.
   *  lastSeenInGroupAt`) until 2026-09-09; a group message now refreshes
   *  the sender's sighting, so that MAX measures CHATTER, not the sweep,
   *  and this rule would have gone quiet during a live outage. */
  lastParticipantSweepAt: Date | null;
  /** The org's next upcoming match, or null. */
  nextMatchAt: Date | null;
  /**
   * `AnalyzedMessage` rows in the last 24h with NEITHER an author user NOR
   * an author name. Each one is a message the server could not attribute
   * to anybody, and before 2026-09-09 each was invisible to every queue
   * built to catch exactly that.
   */
  namelessUnattributed24h: number;
  /**
   * Is the nightly `none`-bucket shadow sweep switched on
   * (`NONE_BUCKET_SHADOW_ENABLED`)?
   *
   * Read from the env by the cron, not from the database, because the
   * flag IS the env var. When it is off the rule below says nothing —
   * see the argument there.
   */
  noneShadowEnabled: boolean;
  /**
   * When the `none`-bucket sweep last filed a `WindowVerdict` for this
   * org — `MAX(windowEnd)` over rows whose `batchHash` starts with
   * `NONE_SHADOW_BATCH_PREFIX`. Null when it never has.
   *
   * This is the sweep's heartbeat, and it only became one on 2026-09-11:
   * until then the row was filed only when the sweep found something, so
   * a healthy night and a dead cron were the same absence.
   */
  lastNoneShadowAt: Date | null;
}

export interface HealthFinding {
  code: HealthCode;
  severity: "critical" | "warning";
  /**
   * A bare noun phrase, for the one-line "still broken since …" roll-up.
   * Defaults to `labelForCode`; a rule may override it to carry a count
   * that earns its place in a list ("4 bot capabilities").
   */
  label: string;
  /** One line. Goes in the alert body verbatim. */
  headline: string;
  /** What it costs the club, and what to do. */
  detail: string;
  /**
   * The last moment this was demonstrably HEALTHY, where the rule knows
   * it: the last heartbeat for `pi-silent`, the last successful sweep
   * for `sweep-stale`, and so on.
   *
   * Set only by rules defined as "X last happened at T", because for
   * those the database is holding the answer already. The counter-driven
   * rules leave it undefined: the Pi's counters are cumulative per
   * process, so a non-zero `droppedMessages` says a message was dropped
   * at SOME point in this process's life and not when.
   *
   * It exists because the alternative is a small, visible lie. Sutton
   * FC's sweep last succeeded on 2026-07-07 and this monitor first ran
   * on 2026-09-09; a roll-up line reading "still broken since 9 Sep"
   * about a fault the owner knows began in July is exactly the kind of
   * wrongness that stops the rest of the message being believed.
   */
  brokenSince?: Date;
}

/**
 * The noun phrase each code goes by in a list.
 *
 * Separate from `headline` because a headline is a sentence with a
 * number in it ("4 confirmation reaction(s) could not be placed") and a
 * list needs a name. It is keyed by code rather than carried on the
 * finding because a RESOLVED finding no longer exists to carry anything:
 * all that survives it is its code and the date it started.
 */
const CODE_LABELS: Record<HealthCode, string> = {
  "pi-silent": "the bot's heartbeat",
  "seen-not-buffered": "the inbound buffer",
  "messages-dropped": "dropped messages",
  "synthetic-ids": "unreadable message ids",
  "enrichment-degraded": "sender lookups",
  "nameless-senders": "unattributable senders",
  "reactions-failing": "confirmation reactions",
  "capability-degraded": "bot capabilities",
  "sweep-stale": "the participant sweep",
  "none-shadow-stale": "the nightly none-bucket sweep",
  "inbound-silent": "the inbound message pipe",
};

/** The list name for a code, including one this build has never heard of. */
export function labelForCode(code: string): string {
  return CODE_LABELS[code as HealthCode] ?? code;
}

function ageText(ms: number): string {
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} minutes`;
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)} hours`;
  return `${Math.round(ms / DAY)} days`;
}

/**
 * Decide what, if anything, is wrong with an org's WhatsApp pipeline.
 *
 * Order of the returned findings is stable (declaration order below), so
 * the alert text is stable and the dedupe key is stable.
 */
export function assessBotHealth(input: HealthInput): HealthFinding[] {
  const findings: HealthFinding[] = [];

  // A club that has switched the bot off is not broken, it is off. This
  // covers the churned-customer case (Sutton Lads, June 2026) where every
  // downstream signal looks like a total outage and all of it is correct.
  if (!input.botEnabled) return findings;

  const hb = input.heartbeat;
  const now = input.now.getTime();

  // ── 1. The Pi has stopped reporting ────────────────────────────────
  //
  // This is the half that matters most, because the failures that make
  // the Pi send NOTHING are exactly the ones a Pi-driven heartbeat cannot
  // report: a crashed process, an unplugged Pi, a dead SD card, a revoked
  // WhatsApp session, an expired API key, a router reboot.
  //
  // NOTE the deliberate asymmetry: a MISSING heartbeat row (`hb === null`)
  // is NOT an alert. The server ships on merge and the Pi is deployed by
  // hand, so between the two there is a window where a perfectly healthy
  // Pi simply does not know this endpoint exists. Alerting there would
  // guarantee a false page on the day this shipped, which is the fastest
  // possible way to get the channel muted. The cost is stated honestly:
  // until the Pi is deployed, `pi-silent` cannot fire — the server-side
  // findings below still can, because they read data an older Pi already
  // produces.
  const piSilent = hb !== null && now - hb.at.getTime() > HEARTBEAT_SILENT_MS;
  if (piSilent && hb) {
    findings.push({
      code: "pi-silent",
      severity: "critical",
      label: labelForCode("pi-silent"),
      // The last heartbeat IS the last moment the Pi was demonstrably
      // alive, so the outage is at least this old however long ago the
      // alerting started.
      brokenSince: hb.at,
      headline: `The WhatsApp bot has not reported for ${ageText(now - hb.at.getTime())}.`,
      detail:
        "It reports every 10 minutes whether or not it has anything to say, so this " +
        "means the process is down, the Pi is offline, or it cannot reach the API. " +
        "Nothing typed in the group is being recorded and nothing queued will be " +
        "posted. Check the Pi: `systemctl status matchtime-bot`, then redeploy with " +
        "`scripts/deploy-pi.sh` (never a bare `systemctl restart`).",
    });
  }

  if (hb) {
    const c = hb.counters;

    // ── 2. Messages arrived and none of them was buffered ────────────
    //
    // The August signature. `seen` counts every inbound handler call and
    // `notGroup` counts the ones that were correctly skipped as DMs, so
    // `seen - notGroup` is the number of GROUP messages the handler was
    // asked to deal with. If that is non-zero and `buffered` is zero,
    // every single one was lost between the handler and the buffer.
    //
    // This cannot false-alarm on a quiet group, and that is the whole
    // reason it is shaped this way: a silent group produces
    // `seen === notGroup`, so the guard is never even reached.
    const groupMessages = c.seen - c.notGroup;
    if (groupMessages > 0 && c.buffered === 0) {
      findings.push({
        code: "seen-not-buffered",
        severity: "critical",
        label: labelForCode("seen-not-buffered"),
        headline: `${groupMessages} group message(s) reached the bot and NONE was queued for analysis.`,
        detail:
          "This is the exact shape of the August 2026 outage: the inbound handler ran " +
          "all day and every message was dropped before the buffer, so no attendance " +
          "was recorded and nothing said so. Read the Pi's journal for CRITICAL lines.",
      });
    }

    // ── 3. A batch was given up on ───────────────────────────────────
    //
    // The Pi retries a failed analyze POST and, past the ceiling, drops
    // the batch. Any non-zero count is a customer's IN or OUT that will
    // never be recorded. There is no acceptable level of this, hence the
    // threshold of zero.
    if (c.droppedMessages > 0) {
      findings.push({
        code: "messages-dropped",
        severity: "critical",
        label: labelForCode("messages-dropped"),
        headline: `${c.droppedMessages} message(s) never reached the analyzer and were given up on.`,
        detail:
          "The analyze POST failed repeatedly (a 5xx, a timeout, or a rejected API " +
          "key). Attendance from those messages is NOT recorded, so check the " +
          "roster against the group by hand before kickoff.",
      });
    }

    // ── 4. The message id could not be read ──────────────────────────
    //
    // A synthesised id keeps dedupe and attendance working but severs
    // everything that needs to point back at a real WhatsApp message:
    // reactions, bench 👍/👎, MoM poll votes. Threshold zero because a
    // single one means the injected layer has already drifted.
    if (c.synthetic > 0) {
      findings.push({
        code: "synthetic-ids",
        severity: "critical",
        label: labelForCode("synthetic-ids"),
        headline: `${c.synthetic} message(s) arrived with an unreadable WhatsApp id.`,
        detail:
          "The bot had to invent an id for those messages because it could not read the " +
          "real one from WhatsApp. Reactions cannot be placed on them, and bench 👍/👎 " +
          "and MoM poll votes on them cannot be matched back. Read the Pi's journal for " +
          "the [baileys] lines around the time it happened.",
      });
    }

    // ── 5. Enrichment fell back ──────────────────────────────────────
    //
    // `getContact()` throwing is the canary for the same drift, one layer
    // down, and it is what destroys sender identity for an @lid player.
    if (c.degradedEnrichment > 0) {
      findings.push({
        code: "enrichment-degraded",
        severity: "critical",
        label: labelForCode("enrichment-degraded"),
        headline: `${c.degradedEnrichment} message(s) lost their sender lookup.`,
        detail:
          "The contact lookup threw, so the message reached the analyzer with only " +
          "whatever identity the raw payload carried. For an @lid privacy member that " +
          "can mean no identity at all, and their IN/OUT is then unattributable.",
      });
    }

    // ── 6. Reactions ─────────────────────────────────────────────────
    //
    // A WARNING, not a critical: attendance IS still recorded and the
    // text catch-up post covers the player's confirmation. It reads to
    // the club as "the bot is broken", which matters, but nobody turns up
    // to the wrong pitch over it.
    if (c.reactFailures > 0) {
      findings.push({
        code: "reactions-failing",
        severity: "warning",
        label: labelForCode("reactions-failing"),
        headline: `${c.reactFailures} confirmation reaction(s) could not be placed.`,
        detail:
          "Attendance IS recorded and the bot posts a text catch-up, but players are " +
          "not getting the ✅/🪑 they expect and will assume the bot is dead.",
      });
    }

    // ── 7. Whatever the Pi itself declared dead ──────────────────────
    //
    // Forwarded verbatim rather than re-derived, so a capability added to
    // `whatsapp-bot/src/degraded.ts` shows up here without this file
    // needing to know about it.
    if (hb.degradedCapabilities.length > 0) {
      findings.push({
        code: "capability-degraded",
        severity: "warning",
        // The one label that carries a number: "4 bot capabilities" is
        // worth four characters in the roll-up line, because the count
        // going UP is the only thing about this finding that ever
        // changes while it stays broken.
        label: `${hb.degradedCapabilities.length} ${labelForCode("capability-degraded")}`,
        headline: `The bot reported ${hb.degradedCapabilities.length} degraded capability/capabilities.`,
        detail: `Degraded: ${hb.degradedCapabilities.join(", ")}. See the CRITICAL lines on the Pi for what each one costs.`,
      });
    }
  }

  // ── 8. A sender nobody could name ──────────────────────────────────
  //
  // The audit's recommendation #1 in signal form. A message with neither
  // a phone nor a name cannot be attributed, registers no attendance,
  // returns HTTP 200, and — until the changes shipped alongside this
  // module — appeared in no admin queue and triggered no group nudge.
  // Counted from BOTH sides: the Pi's own tally (which sees the message
  // before the server does) and the server's `AnalyzedMessage` rows
  // (which catch it even from an older Pi build that sends no heartbeat).
  const namelessFromPi = input.heartbeat?.counters.nameless ?? 0;
  const namelessTotal = input.namelessUnattributed24h + namelessFromPi;
  if (namelessTotal > 0) {
    findings.push({
      code: "nameless-senders",
      severity: "critical",
      label: labelForCode("nameless-senders"),
      headline: `${namelessTotal} message(s) arrived with no phone and no name.`,
      detail:
        "Nobody can be resolved from those, so any attendance in them was silently " +
        "not written. They are listed under Players → Unresolved as an unknown sender.",
    });
  }

  // ── 9. The participant sweep ───────────────────────────────────────
  //
  // Threshold deliberately REUSES `GROUP_SYNC_FRESHNESS_DAYS`, the
  // constant the web app's self-IN gate already uses to decide whether
  // `lastSeenInGroupAt` can be trusted as evidence of absence. Two
  // numbers here would eventually disagree, and then the dashboard and
  // the alert would tell an admin different things about the same fact.
  const sweepStaleMs = GROUP_SYNC_FRESHNESS_DAYS * DAY;
  const sweepAt = input.lastParticipantSweepAt;
  if (sweepAt === null || now - sweepAt.getTime() > sweepStaleMs) {
    findings.push({
      code: "sweep-stale",
      severity: "warning",
      label: labelForCode("sweep-stale"),
      // 2026-07-07 for Sutton FC, in the database the whole time. This
      // is what lets the roll-up say "still broken since 7 Jul" rather
      // than the day this monitor happened to be switched on.
      brokenSince: sweepAt ?? undefined,
      headline:
        sweepAt === null
          ? "MatchTime has never managed to read this group's member list."
          : `The group's member list was last read ${ageText(now - sweepAt.getTime())} ago.`,
      detail:
        "The startup participant sweep is the only thing that can read the group's " +
        "roster, so while it is down MatchTime cannot tell who is in the group. A player " +
        "who has posted in the group since is fine: their own message confirms them. A " +
        "player who joined recently and has not typed can only be vouched for by a squad " +
        "they were already put in; otherwise they cannot mark themselves in on the app " +
        "(replying IN in the group still works), and members who were there before the " +
        "bot stay invisible.",
    });
  }

  // ── 10. The only thing watching the `none` bucket has gone quiet ───
  //
  // `pipeline/gate.ts` calls the nightly shadow sweep "the ONLY remaining
  // thing watching for a real IN that the router called banter", and
  // rests its whole containment argument on it. On 2026-09-11 that sweep
  // was found to have filed ONE row in its entire life — 1 of 506
  // `WindowVerdict` rows — because the cron only filed a row when it had
  // an alert to report. A clean night wrote nothing, and so did a dead
  // cron. The sweep now files unconditionally, which turns the row into a
  // heartbeat, and this rule is the half that notices its absence. It is
  // the same shape as `pi-silent`: the failures that cost the most (a
  // crashed cron, a revoked key, a flag turned off by mistake, a deploy
  // that dropped the schedule) all look like nothing arriving.
  //
  // TWO deliberate asymmetries, both about not becoming noise:
  //
  //   a. THE FLAG OFF IS SILENCE. `NONE_BUCKET_SHADOW_ENABLED` defaults
  //      OFF and turning it on is a deliberate act. A job nobody asked to
  //      run is not a fault, and paging about one every single day
  //      forever is how this channel gets muted — which matters more than
  //      usual right now, with four capabilities degraded since July
  //      already on that timer. If the sweep is off, what is void is
  //      `gate.ts`'s containment argument, and that is a product decision
  //      to take in daylight, not an ops page.
  //
  //   b. NEVER-FILED IS A FINDING, unlike `pi-silent`'s never-heard-from.
  //      The difference is who deploys: the Pi is flashed by hand and can
  //      legitimately be older than the server, but this sweep and this
  //      rule ship in the same commit to the same Vercel project. With
  //      the flag on, one night with no row means the cron did not run.
  const shadowAt = input.lastNoneShadowAt;
  if (
    input.noneShadowEnabled &&
    (shadowAt === null || now - shadowAt.getTime() > NONE_SHADOW_SILENT_MS)
  ) {
    findings.push({
      code: "none-shadow-stale",
      severity: "warning",
      label: labelForCode("none-shadow-stale"),
      brokenSince: shadowAt ?? undefined,
      headline:
        shadowAt === null
          ? "The nightly `none`-bucket sweep has never filed a result."
          : `The nightly \`none\`-bucket sweep last filed a result ${ageText(now - shadowAt.getTime())} ago.`,
      detail:
        "It runs at 03:00 and files a row every night whether or not it finds anything, so " +
        "no row means it did not run. Nothing is broken for the club today, but while it " +
        "is down, a message the router dismissed as banter when it was really somebody's " +
        "IN will never be found by anybody, because nothing else ever re-reads the `none` " +
        "bucket. Check the Vercel cron for /api/cron/none-bucket-shadow, and that " +
        "NONE_BUCKET_SHADOW_ENABLED and ANTHROPIC_API_KEY are still set.",
    });
  }

  // ── 11. A live group has gone silent before a fixture ──────────────
  //
  // The one rule here that is a GUESS rather than a measurement: silence
  // looks the same whether the group is quiet or the bot has gone deaf.
  // So it is a warning, never a critical, and its copy says both. It
  // carries four guards, every one of which exists because of a specific
  // false alarm:
  //
  //   a. a fixture within 36h        : no match, never fires (a break)
  //   b. 30h of silence              : clears a quiet weekend before a
  //      Tuesday game (see `INBOUND_SILENT_MS`, 2026-09-28)
  //   c. the group spoke in the last 14 days: a dormant or churned club
  //      is silent because it is gone, not because we cannot hear it
  //   d. `pi-silent` is not already firing: one outage, one finding
  //
  // Guard (d) is what stops a dead Pi producing two findings for one
  // cause. It reads a value computed above; nothing below this block
  // depends on it, so there is no guard being skipped here.
  const lastMsg = input.lastAnalyzedMessageAt;
  const matchAt = input.nextMatchAt;
  if (!piSilent && lastMsg !== null && matchAt !== null) {
    const untilMatch = matchAt.getTime() - now;
    const sinceMsg = now - lastMsg.getTime();
    const matchImminent = untilMatch > 0 && untilMatch <= MATCH_IMMINENT_MS;
    const groupIsLive = sinceMsg <= GROUP_ALIVE_WINDOW_MS;
    if (matchImminent && groupIsLive && sinceMsg > INBOUND_SILENT_MS) {
      findings.push({
        code: "inbound-silent",
        severity: "warning",
        label: labelForCode("inbound-silent"),
        brokenSince: lastMsg,
        headline: `No message from this group has reached MatchTime for ${ageText(sinceMsg)}, with a match in ${ageText(untilMatch)}.`,
        detail:
          "The group may simply be quiet. If people have been posting in it, the bot is " +
          "not hearing them: check that it is still linked to WhatsApp and that the Pi's " +
          "heartbeat is fresh.",
      });
    }
  }

  return findings;
}
