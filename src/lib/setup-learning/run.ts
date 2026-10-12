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
 *      AI cap (`withSetupReadingAiBudget`). At the cap: deferred, retried
 *      by a later sweep (tomorrow's allowance).
 *   4. PLAN (rules.ts) and APPLY in one compare-and-set write: each
 *      switched column must still hold the value the plan saw, and the
 *      organiser must not have saved any of those settings meanwhile.
 *      If the club moved, it is planned again from a fresh read once.
 *   5. RECORD what was detected, applied, suggested, noted and kept, with
 *      the call's tokens and cost, and CLEAR the stored chat.
 *   6. DM the organiser once (purpose "setup-learned", refId
 *      "<orgId>:setup-learned"), on the platform channel, in the daytime
 *      (09:00 to 23:00 London; a night run waits for 09:00), only when
 *      there is something to say. NOT for a club that is approved but
 *      setting up (go-live slice S3): its one setup DM carries the
 *      findings instead (club-setup-dm.ts).
 *
 * Sutton FC can never be read: it has no `approvedAt` (it was approved by
 * the column default) and no connect request.
 *
 * APPROVED BUT SETTING UP (go-live slice S1, 2026-10-12). A club that is
 * held silent until its organiser says GO has its bot OFF, so the sweep
 * selects "bot on and never held, OR setting up", and the reading spends
 * through the one AI budget scope that allows such a club anything.
 *
 * ONCE SUCH A CLUB IS LIVE IT IS NEVER READ OR CHANGED. The hello has told
 * the group how the club runs, so three locks keep a late reading out:
 *   - the sweep does not select a club with a go-live stamp (`liveAt`),
 *     whatever its reading row says (deferred an hour ago, never started);
 *   - `learnClubSetup` refuses one before claiming anything;
 *   - the settings write is a compare-and-set on the stage the run began
 *     in: "still setting up" for a held club, "no go-live stamp" for any
 *     other. A reading in flight when the organiser says GO therefore
 *     changes nothing, and what it would have switched is recorded as
 *     kept, reason "went-live" (or "no-longer-approved" when the club was
 *     suspended instead).
 * Every club that exists today has no go-live stamp and is read exactly
 * as before.
 *
 * A READING ONLY WRITES A ROW IT STILL HOLDS (PR #235 review fix 5). The
 * row is this run's while its status is "running". It can be CLOSED FOR
 * GOOD under a run that is still waiting for the model: by go-live
 * (`closeUnfinishedSetupLearning`), by the setup DM's 2-hour cap or by the
 * DM going with the reading off (`closeReadingForGood`, club-setup-dm.ts).
 * "Closed for good" must then be true, so:
 *   - every write of the row (`finish`) is a compare-and-set on status
 *     "running": a closed row is never overwritten, not with a result and
 *     not with "deferred" (which would have it read again);
 *   - the settings write and the record of it are ONE transaction that
 *     locks the club's row and then takes the reading row (the same
 *     compare-and-set). A closer arriving in that instant waits for the
 *     transaction, then finds the row final and leaves it alone; a closer
 *     that got there first makes the compare-and-set fail, and nothing is
 *     applied.
 * THE LOCK ORDER is written once, at the top of club-setup.ts: the
 * club's row (FOR NO KEY UPDATE, `lockClubSetup`), then the reading row.
 * `goLiveClub`, the setup DM's cap and the owner's suspension follow the
 * same order, so none can deadlock with this. The claim and every write
 * outside `applyAndRecord` are single statements outside any transaction.
 * A run that finds its row closed returns "skipped", reason "closed". For
 * a club nobody closes (every club that is not held) the row is "running"
 * throughout and the reading behaves exactly as before.
 */
import { db } from "../db";
import { clearCapturedChat } from "../captured-chat";
import { APPROVED_CLUB_WHERE, servingClubWhere } from "../club-approval";
import {
  NEVER_HELD_WHERE,
  SETTING_UP_CLUB_WHERE,
  SETUP_READABLE_CLUB_WHERE,
  SETUP_STAGE_SELECT,
  hasGoneLive,
  isClubSettingUp,
  lockClubSetup,
  type SetupStageColumns,
} from "../club-setup";
import { withSetupReadingAiBudget } from "../ai-budget";
import { isAiBudgetExceeded } from "../ai-budget-context";
import { anthropicModel, budgetedModel, extractJson, type ModelResponse, type PipelineModel } from "../pipeline/llm";
import { coerceHistoryMessages } from "../onboarding-enrichment-reconcile";
import { detectGroupLang } from "../i18n/detect";
import { appUrl, buildAdminLink } from "../admin-link";
import { PlatformDmRefused, queuePlatformDm } from "../platform-jobs";
import { messageHoursSendAfter } from "../message-hours";
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
  ...SETUP_STAGE_SELECT,
  liveAt: true,
  rollingSquadEnabled: true,
  benchPickMode: true,
  dropOutDeadlineDay: true,
  dropOutDeadlineTime: true,
  listPublishDay: true,
  listPublishTime: true,
  paymentTrackingEnabled: true,
  settingsSetByOrganiser: true,
} as const;

type OrgRow = OrgSettingsState &
  SetupStageColumns & {
    id: string;
    name: string;
    approvedAt: Date | null;
    whatsappBotEnabled: boolean;
    liveAt: Date | null;
  };

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

/** `db`, or a transaction client. */
type RowClient = {
  clubSetupLearning: { updateMany(args: { where: object; data: object }): Promise<{ count: number }> };
  organisation: { updateMany(args: { where: object; data: object }): Promise<{ count: number }> };
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
};

/**
 * Write the row, ONLY while this run still holds it (status "running").
 * False: the row was closed for good under this run, and nothing was
 * written.
 */
async function finish(orgId: string, data: Record<string, unknown>, client: RowClient = db as unknown as RowClient): Promise<boolean> {
  const { count } = await client.clubSetupLearning.updateMany({ where: { orgId, status: "running" }, data });
  return count === 1;
}

/** What a run returns when its row was closed for good under it. */
function closedUnderUs(orgId: string): LearnOutcome {
  console.log(`[setup-learning] ${orgId}: the reading was closed while it was in flight; nothing applied, nothing recorded`);
  return { kind: "skipped", reason: "closed" };
}

/** The chat is read once: after a final outcome it is deleted, and the
 *  group description captured with it (captured-chat.ts). */
async function clearHistory(connectId: string): Promise<void> {
  await clearCapturedChat(db, connectId);
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

/**
 * The compare-and-set write. False when the club moved under us.
 * `held`: the club was setting up when this run read it, so the write
 * lands only while it STILL is. Any other club is written only while it
 * has no go-live stamp. Either way a club that has gone live is never
 * changed.
 */
async function applyPlan(
  orgId: string,
  org: OrgSettingsState,
  plan: SetupPlan,
  held: boolean,
  client: RowClient = db as unknown as RowClient,
): Promise<boolean> {
  if (plan.applied.length === 0) return true;
  const where: Record<string, unknown> = {
    id: orgId,
    ...(held ? SETTING_UP_CLUB_WHERE : { ...APPROVED_CLUB_WHERE, ...NEVER_HELD_WHERE }),
  };
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
  const { count } = await client.organisation.updateMany({ where, data: plan.data });
  return count === 1;
}

/**
 * Apply the plan and record it, as ONE transaction that locks the club's
 * row, then takes the reading row (the lock order, see the header):
 *   "closed"  the row is no longer this run's: nothing applied, nothing written;
 *   "moved"   the club's settings write was refused: nothing written, the
 *             caller plans again from a fresh read;
 *   "done"    applied (or nothing to apply) and recorded.
 */
async function applyAndRecord(
  orgId: string,
  org: OrgSettingsState,
  plan: SetupPlan,
  held: boolean,
  record: (plan: SetupPlan) => Record<string, unknown>,
): Promise<"closed" | "moved" | "done"> {
  return db.$transaction(async (client) => {
    const tx = client as unknown as RowClient;
    // Step 1 of the lock order (club-setup.ts): the club's row, FOR NO
    // KEY UPDATE. Go-live, the cap's close and a suspension take it first
    // too; nobody inserting a row for this club is made to wait.
    await lockClubSetup(tx, orgId);
    // Then the reading row, only while it is still this run's. A no-op
    // write, so the row is locked until this transaction ends.
    if (!(await finish(orgId, { status: "running" }, tx))) return "closed";
    if (!(await applyPlan(orgId, org, plan, held, tx))) return "moved";
    await finish(orgId, record(plan), tx);
    return "done";
  });
}

export async function learnClubSetup(orgId: string, opts: LearnOptions = {}): Promise<LearnOutcome> {
  const now = opts.now ?? new Date();
  const org = await loadOrg(orgId);
  if (!org || !org.approvedAt) return { kind: "not-eligible" };
  // Read ONCE, here: a club that was held when the reading started stays
  // "held" for this run even if it goes live before the write.
  const held = isClubSettingUp(org);
  // It has been through the hold and is live: never read, whatever its
  // reading row says. Before the claim, so nothing is written for it.
  if (!held && hasGoneLive(org)) return { kind: "not-eligible" };
  if (!(await claim(orgId, now))) return { kind: "taken" };

  const connect = await db.clubConnect.findFirst({
    where: { orgId, status: "closed", linkedAt: { not: null } },
    orderBy: { linkedAt: "desc" },
    select: { id: true, userId: true, phone: true, groupSubject: true, capturedHistory: true },
  });
  if (!connect) {
    if (!(await finish(orgId, { status: "skipped", reason: "no-organiser" }))) return closedUnderUs(orgId);
    return { kind: "skipped", reason: "no-organiser" };
  }

  const history = coerceHistoryMessages(connect.capturedHistory);
  const gate = historyGate(history);
  if (!gate.ok) {
    if (!(await finish(orgId, { status: "skipped", reason: gate.reason, messageCount: gate.messages, authorCount: gate.authors }))) {
      return closedUnderUs(orgId);
    }
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
    resp = await withSetupReadingAiBudget(orgId, () =>
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
  // What is written on the row for a plan: the same record as before.
  const record = (p: SetupPlan): Record<string, unknown> => ({
    status: p.applied.length > 0 ? "applied" : "nothing",
    reason: detection.regularGame ? null : "not-a-game-group",
    detected: detection as unknown as object,
    applied: p.applied as unknown as object,
    suggestions: p.suggestions as unknown as object,
    noted: p.noted as unknown as object,
    kept: p.kept as unknown as object,
    ...usage,
  });
  let state = orgSettings(org);
  let plan = planSetup({ detection, org: state, weeklyGame, activities: slots, chatLanguage });
  let res = await applyAndRecord(orgId, state, plan, held, record);
  // Why a HELD club's write was refused, when it was the club that moved:
  // suspended (no approved club to load) or gone live (no longer setting
  // up). null: the club is where it was, so the organiser changed a
  // setting. A club that was not held cannot move this way, and is
  // re-planned exactly as before.
  const movedTo = (fresh: OrgRow | null): "no-longer-approved" | "went-live" | null =>
    !held ? null : !fresh ? "no-longer-approved" : isClubSettingUp(fresh) ? null : "went-live";
  let moved: "no-longer-approved" | "went-live" | null = null;
  if (res === "moved") {
    const fresh = await loadOrg(orgId);
    moved = movedTo(fresh);
    if (fresh && !moved) {
      state = orgSettings(fresh);
      plan = planSetup({ detection, org: state, weeklyGame, activities: slots, chatLanguage });
      res = await applyAndRecord(orgId, state, plan, held, record);
      // Still refused, and it was held: see whether it moved just now.
      if (res === "moved" && held) moved = movedTo(await loadOrg(orgId));
    }
  }
  if (res === "moved") {
    // The club left setting-up under us: a late reading changes nothing.
    // Otherwise the organiser is changing settings right now: leave them
    // alone.
    const reason = moved ?? ("organiser-set" as const);
    plan = { ...plan, kept: [...plan.kept, ...plan.applied.map((a) => ({ key: a.key, reason }))], applied: [], data: {} };
    res = (await finish(orgId, record(plan))) ? "done" : "closed";
  }
  // Closed for good while the model was answering: nothing was applied and
  // the closed row stands. The closer deleted the stored chat.
  if (res === "closed") return closedUnderUs(orgId);

  const status = plan.applied.length > 0 ? "applied" : "nothing";
  await clearHistory(connect.id);

  // ── The organiser's one DM ───────────────────────────────────────────
  // A club that was HELD when this run began (go-live slice S3) is never
  // sent this DM: its ONE setup DM (club-setup-dm.ts) carries the same
  // findings, composed from the record just written, and is sent by the
  // caller once this reading is final. Every other club: exactly as before.
  let dmQueued = false;
  if (planIsWorthTelling(plan) && !held) {
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
    if (!(await finish(orgId, { status: "failed", reason }))) return closedUnderUs(orgId);
    await clearHistory(connectId);
    return { kind: "failed", reason };
  }
  // Never back to "deferred" over a closed row: it would be read again.
  if (!(await finish(orgId, { status: "deferred", reason }))) return closedUnderUs(orgId);
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
    await queuePlatformDm({ phone: connect.phone, text, purpose: SETUP_DM_PURPOSE, refId, sendAfter: messageHoursSendAfter(now) });
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
      // The bot is on and the club was never held, or the club is approved
      // and setting up (its bot is off until GO). A club that has gone
      // live after a hold is never selected. Under AND because the query
      // has an OR of its own.
      AND: [SETUP_READABLE_CLUB_WHERE],
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
