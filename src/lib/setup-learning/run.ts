/**
 * F3, LEARNED SETUP: THE DATABASE HALF (2026-10-05).
 *
 * `runSetupLearningSweep` (the 15-minute cron, behind
 * SETUP_LEARNING_ENABLED) finds self-join clubs approved in the last
 * SWEEP_WINDOW_DAYS that have not been read yet, and runs
 * `learnClubSetup` for each:
 *
 *   1. CLAIM the club's one ClubSetupLearning row (orgId is unique, so
 *      two sweeps cannot both read a club). A row "deferred" by the AI cap
 *      or a model error, or stuck "running" for STUCK_AFTER_MS, is
 *      reclaimed up to MAX_ATTEMPTS times.
 *   2. READ the chat the group add stored on the connect request
 *      (ClubConnect.capturedHistory). Empty or too short: skipped, no
 *      model call, no change, no DM.
 *   3. ONE MODEL CALL (Haiku, structured output) inside the club's daily
 *      AI cap (`withOrgAiBudget`). At the cap: deferred, retried by a
 *      later sweep (tomorrow's allowance).
 *   4. PLAN (rules.ts) and APPLY in one compare-and-set write: each
 *      switched column must still hold the value the plan saw, and the
 *      organiser must not have saved any of those settings meanwhile.
 *      If the club moved, it is planned again from a fresh read once.
 *   5. RECORD what was detected, applied, suggested, noted and kept, with
 *      the call's tokens and cost, and CLEAR the stored chat.
 *   6. DM the organiser once (purpose "setup-learned", refId
 *      "<orgId>:setup-learned"), on the platform channel, in the daytime
 *      (10:00 to 20:00 London; a night run waits for 10:00), only when
 *      there is something to say.
 *
 * Sutton FC can never be read: it has no `approvedAt` (it was approved by
 * the column default) and no connect request.
 */
import { db } from "../db";
import { APPROVED_CLUB_WHERE, servingClubWhere } from "../club-approval";
import { withOrgAiBudget } from "../ai-budget";
import { isAiBudgetExceeded } from "../ai-budget-context";
import { anthropicModel, budgetedModel, extractJson, type ModelResponse, type PipelineModel } from "../pipeline/llm";
import { coerceHistoryMessages } from "../onboarding-enrichment-reconcile";
import { detectGroupLang } from "../i18n/detect";
import { appUrl, buildAdminLink } from "../admin-link";
import { PlatformDmRefused, queuePlatformDm } from "../platform-jobs";
import { billingDmSendAfter } from "../club-billing-schedule-rules";
import {
  SETUP_LEARNING_MAX_TOKENS,
  SETUP_LEARNING_MODEL,
  SETUP_LEARNING_SCHEMA,
  SETUP_LEARNING_SYSTEM_PROMPT,
} from "./prompt";
import {
  buildUserContent,
  historyGate,
  parseDetection,
  planIsWorthTelling,
  planSetup,
  ORGANISER_SET_KEY,
  type OrgSettingsState,
  type SetupPlan,
  type WeeklyGameState,
} from "./rules";
import { composeSetupDm } from "./dm";
import { isSetupLearningEnabled } from "./flag";

export const SWEEP_WINDOW_DAYS = 3;
export const MAX_PER_SWEEP = 5;
export const MAX_ATTEMPTS = 3;
export const STUCK_AFTER_MS = 30 * 60 * 1000;
export const SETUP_DM_PURPOSE = "setup-learned" as const;
/** The undo links stay clickable for a week (the DM may be read late). */
const LINK_TTL_SECONDS = 7 * 24 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export type LearnOutcome =
  | { kind: "not-eligible" }
  | { kind: "taken" }
  | { kind: "skipped"; reason: string }
  | { kind: "deferred"; reason: "ai-cap" | "model-error" }
  | { kind: "failed"; reason: string }
  | { kind: "done"; status: "applied" | "nothing"; applied: number; suggestions: number; noted: number; dmQueued: boolean };

export interface LearnOptions {
  now?: Date;
  /** Tests and the e2e seam pass a stub; it is put behind the daily cap. */
  model?: PipelineModel;
}

const ORG_SELECT = {
  id: true,
  name: true,
  language: true,
  approvedAt: true,
  whatsappBotEnabled: true,
  rollingSquadEnabled: true,
  benchPickMode: true,
  dropOutDeadlineDay: true,
  dropOutDeadlineTime: true,
  listPublishDay: true,
  listPublishTime: true,
  paymentTrackingEnabled: true,
  settingsSetByOrganiser: true,
} as const;

type OrgRow = OrgSettingsState & { id: string; name: string; approvedAt: Date | null; whatsappBotEnabled: boolean };

async function loadOrg(orgId: string): Promise<OrgRow | null> {
  return (await db.organisation.findFirst({
    where: { id: orgId, ...APPROVED_CLUB_WHERE },
    select: ORG_SELECT,
  })) as OrgRow | null;
}

/** Take the club's one row. "taken" when another run has it or it is done. */
async function claim(orgId: string, now: Date): Promise<boolean> {
  try {
    await db.clubSetupLearning.create({ data: { orgId, status: "running" } });
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code !== "P2002") throw err;
  }
  const { count } = await db.clubSetupLearning.updateMany({
    where: {
      orgId,
      attempts: { lt: MAX_ATTEMPTS },
      OR: [{ status: "deferred" }, { status: "running", updatedAt: { lt: new Date(now.getTime() - STUCK_AFTER_MS) } }],
    },
    data: { status: "running", attempts: { increment: 1 } },
  });
  return count === 1;
}

async function finish(orgId: string, data: Record<string, unknown>): Promise<void> {
  await db.clubSetupLearning.update({ where: { orgId }, data });
}

/** The chat is read once: after a final outcome it is deleted. */
async function clearHistory(connectId: string): Promise<void> {
  await db.$executeRaw`UPDATE "ClubConnect" SET "capturedHistory" = NULL WHERE "id" = ${connectId}`;
}

function orgSettings(o: OrgRow): OrgSettingsState {
  return {
    rollingSquadEnabled: o.rollingSquadEnabled,
    benchPickMode: o.benchPickMode,
    dropOutDeadlineDay: o.dropOutDeadlineDay,
    dropOutDeadlineTime: o.dropOutDeadlineTime,
    listPublishDay: o.listPublishDay,
    listPublishTime: o.listPublishTime,
    paymentTrackingEnabled: o.paymentTrackingEnabled,
    language: o.language,
    settingsSetByOrganiser: o.settingsSetByOrganiser ?? [],
  };
}

/** The compare-and-set write. False when the club moved under us. */
async function applyPlan(orgId: string, org: OrgSettingsState, plan: SetupPlan): Promise<boolean> {
  if (plan.applied.length === 0) return true;
  const where: Record<string, unknown> = { id: orgId, ...APPROVED_CLUB_WHERE };
  for (const a of plan.applied) {
    switch (a.key) {
      case "rollingSquad":
        where.rollingSquadEnabled = org.rollingSquadEnabled;
        break;
      case "organiserPicks":
        where.benchPickMode = org.benchPickMode;
        break;
      case "paymentTracking":
        where.paymentTrackingEnabled = org.paymentTrackingEnabled;
        break;
      case "dropOutDeadline":
        where.dropOutDeadlineDay = org.dropOutDeadlineDay;
        where.dropOutDeadlineTime = org.dropOutDeadlineTime;
        break;
      case "listPublish":
        where.listPublishDay = org.listPublishDay;
        where.listPublishTime = org.listPublishTime;
        break;
    }
  }
  where.NOT = { settingsSetByOrganiser: { hasSome: plan.applied.map((a) => ORGANISER_SET_KEY[a.key]) } };
  const { count } = await db.organisation.updateMany({ where, data: plan.data });
  return count === 1;
}

export async function learnClubSetup(orgId: string, opts: LearnOptions = {}): Promise<LearnOutcome> {
  const now = opts.now ?? new Date();
  const org = await loadOrg(orgId);
  if (!org || !org.approvedAt) return { kind: "not-eligible" };
  if (!(await claim(orgId, now))) return { kind: "taken" };

  const connect = await db.clubConnect.findFirst({
    where: { orgId, status: "closed", linkedAt: { not: null } },
    orderBy: { linkedAt: "desc" },
    select: { id: true, userId: true, phone: true, groupSubject: true, capturedHistory: true },
  });
  if (!connect) {
    await finish(orgId, { status: "skipped", reason: "no-organiser" });
    return { kind: "skipped", reason: "no-organiser" };
  }

  const history = coerceHistoryMessages(connect.capturedHistory);
  const gate = historyGate(history);
  if (!gate.ok) {
    await finish(orgId, { status: "skipped", reason: gate.reason, messageCount: gate.messages, authorCount: gate.authors });
    await clearHistory(connect.id);
    console.log(`[setup-learning] ${orgId}: skipped (${gate.reason}: ${gate.messages} messages, ${gate.authors} people)`);
    return { kind: "skipped", reason: gate.reason };
  }

  const activities = await db.activity.findMany({
    where: { orgId, isActive: true },
    orderBy: { createdAt: "asc" },
    select: { dayOfWeek: true, time: true, venue: true, sport: { select: { playersPerTeam: true } } },
  });
  const first = activities[0];
  const weeklyGame: WeeklyGameState | null = first
    ? { dayOfWeek: first.dayOfWeek, time: first.time, venue: first.venue ?? null, playersPerSide: first.sport?.playersPerTeam ?? null }
    : null;

  // ── The one model call ───────────────────────────────────────────────
  const user = buildUserContent({ groupSubject: connect.groupSubject, weeklyGame, history });
  const model = opts.model ? budgetedModel(opts.model) : anthropicModel();
  let resp: ModelResponse;
  try {
    resp = await withOrgAiBudget(orgId, () =>
      model.complete({
        model: SETUP_LEARNING_MODEL,
        system: SETUP_LEARNING_SYSTEM_PROMPT,
        user: user.text,
        maxTokens: SETUP_LEARNING_MAX_TOKENS,
        schema: SETUP_LEARNING_SCHEMA as unknown as Record<string, unknown>,
        label: "setup-learning",
      }),
    );
  } catch (err) {
    return await modelTrouble(orgId, connect.id, isAiBudgetExceeded(err) ? "ai-cap" : "model-error", err);
  }
  let raw: unknown;
  try {
    raw = extractJson(resp.text);
  } catch (err) {
    return await modelTrouble(orgId, connect.id, "model-error", err);
  }
  const detection = parseDetection(raw, history);
  if (!detection) return await modelTrouble(orgId, connect.id, "model-error", new Error("not an object"));
  const usage = {
    model: SETUP_LEARNING_MODEL,
    inputTokens: resp.usage.inputTokens + resp.usage.cacheReadTokens + resp.usage.cacheWriteTokens,
    outputTokens: resp.usage.outputTokens,
    costUsd: resp.costUsd,
    messageCount: gate.messages,
    authorCount: gate.authors,
  };

  // ── Plan and apply ───────────────────────────────────────────────────
  const chatLanguage = detectGroupLang({ subject: connect.groupSubject, history: history.map((m) => m.text) });
  const slots = activities.map((a) => ({ dayOfWeek: a.dayOfWeek, time: a.time }));
  let state = orgSettings(org);
  let plan = planSetup({ detection, org: state, weeklyGame, activities: slots, chatLanguage });
  let ok = await applyPlan(orgId, state, plan);
  if (!ok) {
    const fresh = await loadOrg(orgId);
    if (fresh) {
      state = orgSettings(fresh);
      plan = planSetup({ detection, org: state, weeklyGame, activities: slots, chatLanguage });
      ok = await applyPlan(orgId, state, plan);
    }
  }
  if (!ok) {
    // The organiser is changing settings right now: leave them alone.
    plan = { ...plan, kept: [...plan.kept, ...plan.applied.map((a) => ({ key: a.key, reason: "organiser-set" as const }))], applied: [], data: {} };
  }

  const status = plan.applied.length > 0 ? "applied" : "nothing";
  await finish(orgId, {
    status,
    reason: detection.regularGame ? null : "not-a-game-group",
    detected: detection as unknown as object,
    applied: plan.applied as unknown as object,
    suggestions: plan.suggestions as unknown as object,
    noted: plan.noted as unknown as object,
    kept: plan.kept as unknown as object,
    ...usage,
  });
  await clearHistory(connect.id);

  // ── The organiser's one DM ───────────────────────────────────────────
  let dmQueued = false;
  if (planIsWorthTelling(plan)) {
    dmQueued = await queueSetupDm({ orgId, org, connect, plan, now });
    if (dmQueued) await db.clubSetupLearning.update({ where: { orgId }, data: { dmQueuedAt: now } });
  }
  console.log(
    `[setup-learning] ${orgId} ("${org.name}"): ${status}, ${plan.applied.length} applied ` +
      `[${plan.applied.map((a) => a.key).join(", ")}], ${plan.suggestions.length} suggestion(s), ` +
      `${plan.noted.length} noted, ${plan.kept.length} kept; ${gate.messages} messages; ` +
      `$${(resp.costUsd ?? 0).toFixed(4)}; DM ${dmQueued ? "queued" : "not sent"}`,
  );
  return {
    kind: "done",
    status,
    applied: plan.applied.length,
    suggestions: plan.suggestions.length,
    noted: plan.noted.length,
    dmQueued,
  };
}

async function modelTrouble(
  orgId: string,
  connectId: string,
  reason: "ai-cap" | "model-error",
  err: unknown,
): Promise<LearnOutcome> {
  const row = await db.clubSetupLearning.findUnique({ where: { orgId }, select: { attempts: true } });
  const last = (row?.attempts ?? MAX_ATTEMPTS) >= MAX_ATTEMPTS;
  console.error(`[setup-learning] ${orgId}: ${reason}${last ? " (last attempt)" : ", will retry"}:`, (err as Error)?.message ?? err);
  if (last) {
    await finish(orgId, { status: "failed", reason });
    await clearHistory(connectId);
    return { kind: "failed", reason };
  }
  await finish(orgId, { status: "deferred", reason });
  return { kind: "deferred", reason };
}

async function queueSetupDm(args: {
  orgId: string;
  org: OrgRow;
  connect: { userId: string; phone: string; groupSubject: string | null };
  plan: SetupPlan;
  now: Date;
}): Promise<boolean> {
  const { orgId, org, connect, plan, now } = args;
  const refId = `${orgId}:setup-learned`;
  const already = await db.platformJob.findFirst({ where: { purpose: SETUP_DM_PURPOSE, refId }, select: { id: true } });
  if (already) return false;
  const link = async (nextPath: string): Promise<string> => {
    try {
      return await buildAdminLink({ userId: connect.userId, orgId, nextPath, ttlSeconds: LINK_TTL_SECONDS });
    } catch (err) {
      console.error(`[setup-learning] ${orgId}: signed-in link to ${nextPath} failed; sending the plain address:`, err);
      return appUrl(nextPath);
    }
  };
  const applied = [];
  for (const a of plan.applied) {
    applied.push({ ...a, undoUrl: await link(`/admin/settings?learned=${a.key}#learned-setup`) });
  }
  const text = composeSetupDm({
    lang: org.language,
    group: connect.groupSubject,
    applied,
    suggestions: plan.suggestions,
    noted: plan.noted,
    scheduleUrl: await link("/admin/activities"),
    settingsUrl: await link("/admin/settings#learned-setup"),
    // Minted only when it is used: the "organisers pick" suggestion, highlighted, with its way to the setting.
    organiserPicksUrl: plan.suggestions.some((sg) => sg.key === "organiserPicks")
      ? await link("/admin/settings?learned=organiserPicks#learned-setup")
      : "",
  });
  try {
    await queuePlatformDm({ phone: connect.phone, text, purpose: SETUP_DM_PURPOSE, refId, sendAfter: billingDmSendAfter(now) });
    return true;
  } catch (err) {
    if (err instanceof PlatformDmRefused) {
      console.error(`[setup-learning] ${orgId}: DM not queued: ${err.reason}`);
      return false;
    }
    throw err;
  }
}

/** The cron's work. Flag off: nothing at all. */
export async function runSetupLearningSweep(
  now: Date = new Date(),
  opts: { enabled?: boolean; model?: PipelineModel } = {},
): Promise<{ enabled: boolean; considered: number; outcomes: Array<{ orgId: string; outcome: LearnOutcome }> }> {
  const enabled = opts.enabled ?? isSetupLearningEnabled();
  if (!enabled) return { enabled, considered: 0, outcomes: [] };
  const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MS);
  const due = await db.organisation.findMany({
    where: {
      ...servingClubWhere(),
      whatsappBotEnabled: true,
      approvedAt: { gte: new Date(now.getTime() - SWEEP_WINDOW_DAYS * DAY_MS) },
      OR: [
        { setupLearning: { is: null } },
        { setupLearning: { is: { status: "deferred", attempts: { lt: MAX_ATTEMPTS } } } },
        { setupLearning: { is: { status: "running", attempts: { lt: MAX_ATTEMPTS }, updatedAt: { lt: stuckBefore } } } },
      ],
    },
    orderBy: { approvedAt: "asc" },
    take: MAX_PER_SWEEP,
    select: { id: true },
  });
  const outcomes: Array<{ orgId: string; outcome: LearnOutcome }> = [];
  for (const o of due) {
    try {
      outcomes.push({ orgId: o.id, outcome: await learnClubSetup(o.id, { now, model: opts.model }) });
    } catch (err) {
      console.error(`[setup-learning] ${o.id}: failed:`, err);
      outcomes.push({ orgId: o.id, outcome: { kind: "failed", reason: (err as Error).message } });
    }
  }
  return { enabled, considered: due.length, outcomes };
}
