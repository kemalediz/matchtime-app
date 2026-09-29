/**
 * ROUTINE OPS ALERTS GO IN A TABLE, NOT IN ANYBODY'S POCKET.
 *
 * Kemal, 2026-09-28, about the daily "WhatsApp layer is degraded" DMs and
 * emails and the "routed to an action but nothing handled it" DMs:
 *
 *   "remove these daily messages... Also remove these daily emails...
 *    Only put them into a dashboard on the website where i can click and
 *    see whenever i want."
 *
 * He never read them, they buried the messages he does need (approval
 * requests for new groups, payment questions), and the most recent one
 * was a false alarm. So the detection stays exactly where it was and
 * only its OUTPUT moved: every routine alert is recorded as an `OpsAlert`
 * row and shown on /admin/health, which only a platform owner
 * (`User.isSuperadmin`) can open.
 *
 * ── Two shapes ───────────────────────────────────────────────────────
 *
 *   CONDITION  `health:<code>`, from the hourly bot-health cron. One row
 *              per stretch of time a rule held for a club: opened the
 *              first hour it holds, refreshed every hour it still does,
 *              closed (`resolvedAt`) the first hour it does not.
 *   EVENT      `operator-note`, from the analyze route: a message was
 *              routed to an action and nothing handled it. One row per
 *              note, never "active", because there is nothing to fix
 *              afterwards, only something to look at.
 *
 * ── What this module does NOT do ─────────────────────────────────────
 *
 * It never queues a `BotJob` and never sends an email. A message that
 * genuinely needs a human to act (an approval request, a fee question to
 * the collector) is not a routine alert and is sent by its own code, as
 * it always was, by creating a `kind: "dm"` `BotJob`. Do not route one
 * of those through here: this is the drawer, not the doorbell.
 */
import { db } from "./db";

export const HEALTH_KIND_PREFIX = "health:";
export const OPERATOR_NOTE_KIND = "operator-note";
/** A club reached its daily AI allowance (`ai-budget.ts`). An event,
 *  recorded once per club per London day, info severity: nothing is
 *  broken, the cap did its job. */
export const AI_CAP_ALERT_KIND = "ai-daily-cap";
/** A message reached analysis more than 30 minutes after it was sent
 *  (`late-message.ts`): attendance recorded silently, nothing else
 *  executed. An event, info severity, never a DM. */
export const LATE_MESSAGE_KIND = "late-message";

export type OpsAlertSeverity = "critical" | "warning" | "info";

/** Kinds that are one-off occurrences rather than conditions that hold. */
const EVENT_KINDS: ReadonlySet<string> = new Set([
  OPERATOR_NOTE_KIND,
  AI_CAP_ALERT_KIND,
  LATE_MESSAGE_KIND,
]);

export function healthKind(code: string): string {
  return `${HEALTH_KIND_PREFIX}${code}`;
}

/** The subset of a `HealthFinding` this module reads. */
export interface HealthFindingLike {
  code: string;
  severity: "critical" | "warning";
  headline: string;
  detail: string;
  brokenSince?: Date;
}

export interface OpenHealthAlert {
  id: string;
  kind: string;
}

export interface HealthRecordPlan {
  create: Array<{
    kind: string;
    severity: OpsAlertSeverity;
    title: string;
    detail: string;
    firstSeenAt: Date;
  }>;
  update: Array<{ id: string; severity: OpsAlertSeverity; title: string; detail: string }>;
  resolve: string[];
}

/**
 * Turn one hourly assessment into row changes. Pure.
 *
 * `open` is every unresolved row for the club, of any kind; rows that are
 * not health conditions are left alone. A second open row for the same
 * condition (two cron ticks racing) is closed rather than kept, so the
 * page never shows one fault twice.
 */
export function planHealthRecord(args: {
  open: OpenHealthAlert[];
  findings: HealthFindingLike[];
  now: Date;
}): HealthRecordPlan {
  const { open, findings, now } = args;
  const plan: HealthRecordPlan = { create: [], update: [], resolve: [] };

  const openByKind = new Map<string, string>();
  for (const row of open) {
    if (!row.kind.startsWith(HEALTH_KIND_PREFIX)) continue;
    if (openByKind.has(row.kind)) plan.resolve.push(row.id);
    else openByKind.set(row.kind, row.id);
  }

  const current = new Set<string>();
  for (const f of findings) {
    const kind = healthKind(f.code);
    current.add(kind);
    const existing = openByKind.get(kind);
    if (existing) {
      plan.update.push({ id: existing, severity: f.severity, title: f.headline, detail: f.detail });
    } else {
      // Dated from when the fault BEGAN where the rule knows it (the last
      // heartbeat, the last sweep), so the page does not say "since this
      // morning" about something that has been true for days. A date in
      // the future is a clock bug and is ignored.
      const began = f.brokenSince && f.brokenSince.getTime() <= now.getTime() ? f.brokenSince : now;
      plan.create.push({
        kind,
        severity: f.severity,
        title: f.headline,
        detail: f.detail,
        firstSeenAt: began,
      });
    }
  }

  for (const [kind, id] of openByKind) {
    if (!current.has(kind)) plan.resolve.push(id);
  }
  return plan;
}

/** Plain English names for the health page. Keyed by row kind. */
const KIND_LABELS: Record<string, string> = {
  "health:pi-silent": "Bot not reporting",
  "health:seen-not-buffered": "Messages not queued",
  "health:messages-dropped": "Messages dropped",
  "health:synthetic-ids": "Unreadable message ids",
  "health:enrichment-degraded": "Sender lookups failing",
  "health:nameless-senders": "Unknown senders",
  "health:reactions-failing": "Reactions failing",
  "health:capability-degraded": "Bot features unavailable",
  "health:sweep-stale": "Member list out of date",
  "health:none-shadow-stale": "Nightly re-check not running",
  "health:inbound-silent": "Group quiet before a match",
  [OPERATOR_NOTE_KIND]: "Message not handled",
  [AI_CAP_ALERT_KIND]: "AI daily cap reached",
  [LATE_MESSAGE_KIND]: "Late message",
};

export function alertKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(HEALTH_KIND_PREFIX, "");
}

/** Is this row something that is wrong RIGHT NOW? Events never are. */
export function isActiveAlert(row: { kind: string; resolvedAt: Date | null }): boolean {
  return row.resolvedAt === null && !EVENT_KINDS.has(row.kind);
}

export type ClubStatus = "ok" | "warning" | "problem";

/** One word per club for the top of the health page. */
export function clubStatus(
  rows: Array<{ kind: string; severity: string; resolvedAt: Date | null }>,
): ClubStatus {
  const active = rows.filter(isActiveAlert);
  if (active.some((r) => r.severity === "critical")) return "problem";
  if (active.length > 0) return "warning";
  return "ok";
}

/**
 * Record one hourly assessment for a club. Never throws: a monitoring
 * write that fails must not stop the sweep reaching the next club.
 */
export async function recordHealthFindings(
  orgId: string,
  findings: HealthFindingLike[],
  now: Date,
): Promise<HealthRecordPlan | null> {
  try {
    const open = await db.opsAlert.findMany({
      where: { orgId, resolvedAt: null, kind: { startsWith: HEALTH_KIND_PREFIX } },
      orderBy: { createdAt: "asc" },
      select: { id: true, kind: true },
    });
    const plan = planHealthRecord({ open, findings, now });
    for (const c of plan.create) {
      await db.opsAlert.create({ data: { orgId, ...c, lastSeenAt: now } });
    }
    for (const u of plan.update) {
      await db.opsAlert.update({
        where: { id: u.id },
        data: { severity: u.severity, title: u.title, detail: u.detail, lastSeenAt: now },
      });
    }
    if (plan.resolve.length > 0) {
      await db.opsAlert.updateMany({
        where: { id: { in: plan.resolve } },
        data: { resolvedAt: now },
      });
    }
    return plan;
  } catch (err) {
    console.error(`[ops-alerts] could not record health for org ${orgId}:`, err);
    return null;
  }
}

/**
 * Record a one-off event, e.g. an operator note. Idempotent on
 * `dedupeKey` per club, so a batch that is re-posted (the Pi retries a
 * failed flush) does not record the same note twice. Never throws.
 */
export async function recordOpsEvent(args: {
  orgId: string | null;
  kind: string;
  severity: OpsAlertSeverity;
  title: string;
  detail: string;
  dedupeKey?: string | null;
  now?: Date;
}): Promise<boolean> {
  const now = args.now ?? new Date();
  try {
    if (args.dedupeKey) {
      const dup = await db.opsAlert.findFirst({
        where: { orgId: args.orgId, kind: args.kind, dedupeKey: args.dedupeKey },
        select: { id: true },
      });
      if (dup) return false;
    }
    await db.opsAlert.create({
      data: {
        orgId: args.orgId,
        kind: args.kind,
        severity: args.severity,
        title: args.title,
        detail: args.detail,
        dedupeKey: args.dedupeKey ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
        // An event is over the moment it happens; see `isActiveAlert`.
        resolvedAt: now,
      },
    });
    return true;
  } catch (err) {
    console.error(`[ops-alerts] could not record ${args.kind}:`, err);
    return false;
  }
}
