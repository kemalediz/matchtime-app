/**
 * THE PLATFORM CHANNEL: DMs and actions that belong to no live club
 * (self-join slice 3, 2026-09-29). Plan: MDs/self-join-and-approval-plan-
 * 2026-09-28.md, sections 3.3, 7 and 12.
 *
 * ── Why it exists ────────────────────────────────────────────────────
 * Everything MatchTime sends used to be a `BotJob` (orgId required) or a
 * computed instruction, and both only go out through `due-posts`, which
 * 404s for any club whose bot is off. A sign-up code has no club, so it
 * borrowed "the first bot-enabled org" as a sender: mute Sutton FC while it
 * is the only live club and every sign-up silently dies. Self-join adds
 * more sends with no live club behind them (the connect reply, the owner's
 * approval DM, the organiser's decision DM, leaving a group), so they get
 * their own queue, `PlatformJob`, and their own endpoint, which the Pi
 * polls once per scheduler tick whatever the clubs' switches say.
 *
 * ── Who may be messaged (plan section 7, rule 12) ────────────────────
 *   otp                 any number. The one standing exception: a code is
 *                       how a number becomes verified. Capped at the
 *                       sign-up action (per phone, per IP, site per day).
 *   connect-reply,      only a number MatchTime already knows (a User with
 *   organiser-decision, that phone: a verified sign-up or a club member).
 *   billing
 *   owner-approval,     NEVER through here. `queueOwnerDm` (owner-dm.ts)
 *   owner-ack           is the only door to Kemal's phone.
 *
 * ── Dispatch: claim-on-dispatch, as due-posts ────────────────────────
 * `claimDuePlatformJobs` flips each job queued -> claimed with a
 * compare-and-set as it hands it out, so two pollers (the duplicate-process
 * class of 2026-07-19) can never both send one job. Delivery is therefore
 * AT-MOST-ONCE, exactly as for BotJobs: a claimed job whose Pi died is not
 * re-emitted.
 *
 * ── Outcomes are honest ──────────────────────────────────────────────
 *   sent         the send resolved. `waMessageId` when the library gave one.
 *   failed       the send threw. `failReason` says why. Not retried (the
 *                BotJob rule: a DM that fails is not re-emitted forever, and
 *                a timed-out send may already have landed), and NEVER
 *                recorded as sent. The BotJob path records a failed DM as
 *                sent; this one does not.
 *   release      the Pi's one-DM-a-minute pacing held it back. Back to
 *                queued, re-emitted on a later poll. Not a failure.
 *   unconfirmed  only via the due-posts bridge: a Pi built before slice 3
 *                acked it without a message id, which that build also does
 *                when the send FAILED.
 *
 * ── Leaving a group ──────────────────────────────────────────────────
 * Refused, at queue time AND again at dispatch time, for any group an
 * APPROVED club owns (muted or dormant included). Sutton FC's group cannot
 * be left through this channel, whatever row somebody writes.
 */
import { db } from "./db";
import { e164Digits } from "./phone";
// The pure half, not club-approval.ts: slice 7 makes club-approval import
// owner-dm, which imports this file, and a cycle there would be silent.
import { APPROVED_CLUB_WHERE } from "./club-approval-state";

// ── Vocabulary ──────────────────────────────────────────────────────────

/** DM purposes anything may queue, subject to the recipient rule above. */
/** "billing": club fee DMs to the billing contact or card holder (club fee
 *  billing, slice B3), queued only by `queueBillingDm` in club-billing.ts. */
/** "setup-learned" (F3, 2026-10-05): the organiser's one DM about the
 *  settings MatchTime set up from the group chat (src/lib/setup-learning). */
export const PLATFORM_DM_PURPOSES = ["otp", "connect-reply", "organiser-decision", "billing", "setup-learned"] as const;
export type PlatformDmPurpose = (typeof PLATFORM_DM_PURPOSES)[number];

/** DM purposes only `queueOwnerDm` may write. */
export const OWNER_DM_PURPOSES = ["owner-approval", "owner-ack"] as const;
export type OwnerDmPurpose = (typeof OWNER_DM_PURPOSES)[number];

export const LEAVE_GROUP_PURPOSE = "leave-group" as const;

export type PlatformJobKind = "dm" | "leave-group";
export type PlatformJobStatus = "queued" | "claimed" | "sent" | "failed" | "unconfirmed";

/** Jobs handed to the Pi per poll. It sends what its DM pacing allows and
 *  releases the rest, as it does for due-posts. */
export const MAX_JOBS_PER_POLL = 5;

/** A sign-up code lives 10 minutes (phone-signup.ts, claim.ts). A code DM
 *  that waited longer than that would deliver a dead code, so it is failed
 *  instead of sent. */
export const OTP_DM_TTL_MS = 10 * 60 * 1000;

const FAIL_REASON_MAX = 500;

// ── The due-posts key (the bridge for a Pi built before slice 3) ────────

const KEY_PREFIX = "platform-";

export function platformJobKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

/** The job id in a `platform-<id>` key; null for every other key class. */
export function parsePlatformJobKey(key: string): string | null {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const id = key.slice(KEY_PREFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * Sent by a Pi built with slice 3 on every due-posts request: "I poll
 * /platform-jobs myself, do not bridge platform DMs to me". A Pi built
 * before slice 3 does not send it, so due-posts bridges sign-up codes to
 * it and they keep flowing while the server is ahead of the Pi.
 * whatsapp-bot/src/api.ts sends the same literal (pinned on both sides).
 */
export const PLATFORM_JOBS_CAPABLE_HEADER = "x-mt-platform-jobs";

/** How many platform DMs one due-posts poll bridges to an older Pi. */
export const BRIDGE_DMS_PER_POLL = 2;

/**
 * The due-posts bridge: platform DMs for a Pi that does not poll
 * /platform-jobs, as ordinary `dm` instructions keyed `platform-<id>`.
 * Empty for a Pi that does. Never throws: a broken bridge (the table not
 * migrated yet, a DB hiccup) must not take a club's due-posts down with it.
 */
export async function bridgePlatformDmsForLegacyPi(
  request: Request,
  now: Date = new Date(),
): Promise<Array<{ kind: "dm"; key: string; phone: string; text: string }>> {
  if (request.headers.get(PLATFORM_JOBS_CAPABLE_HEADER) === "1") return [];
  try {
    const jobs = await claimDuePlatformJobs({ now, kinds: ["dm"], limit: BRIDGE_DMS_PER_POLL });
    const out: Array<{ kind: "dm"; key: string; phone: string; text: string }> = [];
    for (const j of jobs) {
      if (j.kind === "dm") out.push({ kind: "dm", key: platformJobKey(j.id), phone: j.phone, text: j.text });
    }
    return out;
  } catch (err) {
    console.error("[platform-jobs] due-posts bridge failed; platform DMs wait for the next poll:", err);
    return [];
  }
}

// ── Queueing ────────────────────────────────────────────────────────────

export class PlatformDmRefused extends Error {
  override readonly name = "PlatformDmRefused";
  constructor(readonly reason: string) {
    super(`[platform-jobs] DM refused: ${reason}`);
  }
}

/** E.164 digits without "+", or null. Lives in phone.ts (no database), so
 *  pure modules can share it; re-exported here for its existing callers. */
export const platformPhoneDigits = e164Digits;

/**
 * Queue a DM on the platform channel. Throws `PlatformDmRefused` when the
 * recipient rule says no; the caller decides what the person sees.
 */
export async function queuePlatformDm(args: {
  phone: string;
  text: string;
  purpose: PlatformDmPurpose;
  refId?: string | null;
  sendAfter?: Date | null;
}): Promise<{ id: string }> {
  const purpose = args.purpose as string;
  if ((OWNER_DM_PURPOSES as readonly string[]).includes(purpose)) {
    throw new PlatformDmRefused(`"${purpose}" DMs go through queueOwnerDm (src/lib/owner-dm.ts) only`);
  }
  if (!(PLATFORM_DM_PURPOSES as readonly string[]).includes(purpose)) {
    throw new PlatformDmRefused(`unknown purpose "${purpose}"`);
  }
  const digits = platformPhoneDigits(args.phone);
  if (!digits) throw new PlatformDmRefused(`not a phone number: ${JSON.stringify(args.phone)}`);
  const text = typeof args.text === "string" ? args.text : "";
  if (!text.trim()) throw new PlatformDmRefused("empty text");

  if (purpose !== "otp") {
    // Rule 12: MatchTime never messages a number it does not already know.
    const known = await db.user.findFirst({ where: { phoneNumber: `+${digits}` }, select: { id: true } });
    if (!known) throw new PlatformDmRefused(`${purpose}: no MatchTime user has this number`);
  }

  const row = await db.platformJob.create({
    data: {
      kind: "dm",
      phone: digits,
      text,
      purpose,
      refId: args.refId ?? null,
      status: "queued",
      sendAfter: args.sendAfter ?? null,
    },
  });
  return { id: row.id };
}

/**
 * Queue leaving a WhatsApp group (reject, suspend, an unsolicited add).
 * Refused for a group an approved club owns. Idempotent while a leave for
 * the same group is still outstanding.
 */
export async function queuePlatformLeaveGroup(args: {
  groupId: string;
  refId?: string | null;
}): Promise<{ id: string } | { refused: "approved-club-group" | "admin-group" | "not-a-group" }> {
  const groupId = typeof args.groupId === "string" ? args.groupId.trim() : "";
  if (!/@g\.us$/.test(groupId)) return { refused: "not-a-group" };

  const owner = await db.organisation.findFirst({
    where: { ...APPROVED_CLUB_WHERE, whatsappGroupId: groupId },
    select: { id: true },
  });
  if (owner) return { refused: "approved-club-group" };
  // Slice 2a: a club's linked admin group is never left from here (the
  // 48-hour auto-leave, the owner page). Unlinking clears the link first.
  const adminOwner = await db.organisation.findFirst({ where: { adminGroupId: groupId }, select: { id: true } });
  if (adminOwner) return { refused: "admin-group" };

  const outstanding = await db.platformJob.findFirst({
    where: { kind: "leave-group", groupId, status: { in: ["queued", "claimed"] } },
    select: { id: true },
  });
  if (outstanding) return { id: outstanding.id };

  const row = await db.platformJob.create({
    data: {
      kind: "leave-group",
      groupId,
      purpose: LEAVE_GROUP_PURPOSE,
      refId: args.refId ?? null,
      status: "queued",
    },
  });
  return { id: row.id };
}

// ── Dispatch ────────────────────────────────────────────────────────────

/** What the Pi is handed. */
export type PlatformJobInstruction =
  | { id: string; kind: "dm"; phone: string; text: string; purpose: string }
  | { id: string; kind: "leave-group"; groupId: string };

/** The columns dispatch reads. */
export interface PlatformJobRow {
  id: string;
  kind: string;
  phone: string | null;
  groupId: string | null;
  text: string | null;
  purpose: string;
  createdAt: Date;
}

export interface PlatformDispatchPlan {
  /** Hand these out, in this order. */
  dispatch: Array<PlatformJobRow & { instruction: PlatformJobInstruction }>;
  /** Mark these failed with the reason; never hand them out. */
  refuse: Array<{ id: string; reason: string }>;
}

/**
 * Pure: which of these queued, due jobs to hand out now, and which to fail.
 * Sign-up codes first (somebody is looking at a "check WhatsApp" screen),
 * then oldest first.
 */
export function planPlatformDispatch(
  rows: PlatformJobRow[],
  opts: { now: Date; approvedGroupIds: ReadonlySet<string>; limit: number; adminGroupIds?: ReadonlySet<string> },
): PlatformDispatchPlan {
  const refuse: PlatformDispatchPlan["refuse"] = [];
  const ok: PlatformDispatchPlan["dispatch"] = [];
  for (const row of rows) {
    if (row.kind === "dm") {
      if (!row.phone || !row.text) {
        refuse.push({ id: row.id, reason: "malformed: a DM with no phone or no text" });
        continue;
      }
      if (row.purpose === "otp" && opts.now.getTime() - row.createdAt.getTime() > OTP_DM_TTL_MS) {
        refuse.push({
          id: row.id,
          reason: "expired before it could be sent: the sign-up code it carries is no longer valid",
        });
        continue;
      }
      ok.push({ ...row, instruction: { id: row.id, kind: "dm", phone: row.phone, text: row.text, purpose: row.purpose } });
      continue;
    }
    if (row.kind === "leave-group") {
      if (!row.groupId) {
        refuse.push({ id: row.id, reason: "malformed: a leave with no group" });
        continue;
      }
      if (opts.approvedGroupIds.has(row.groupId)) {
        refuse.push({ id: row.id, reason: "refused: an approved club owns this group now" });
        continue;
      }
      if (opts.adminGroupIds?.has(row.groupId)) {
        refuse.push({ id: row.id, reason: "refused: this group is a club's linked admin group now" });
        continue;
      }
      ok.push({ ...row, instruction: { id: row.id, kind: "leave-group", groupId: row.groupId } });
      continue;
    }
    refuse.push({ id: row.id, reason: `unknown kind "${row.kind}"` });
  }
  const rank = (r: PlatformJobRow) => (r.purpose === "otp" ? 0 : 1);
  ok.sort((a, b) => rank(a) - rank(b) || a.createdAt.getTime() - b.createdAt.getTime());
  return { dispatch: ok.slice(0, Math.max(0, opts.limit)), refuse };
}

/**
 * Claim and return the jobs due now. `kinds` narrows what is handed out:
 * the due-posts bridge asks for "dm" only, because a Pi built before slice
 * 3 cannot leave a group.
 */
export async function claimDuePlatformJobs(
  opts: { now?: Date; limit?: number; kinds?: PlatformJobKind[] } = {},
): Promise<PlatformJobInstruction[]> {
  const now = opts.now ?? new Date();
  const kinds = opts.kinds ?? ["dm", "leave-group"];
  const rows = (await db.platformJob.findMany({
    where: {
      status: "queued",
      kind: { in: kinds },
      OR: [{ sendAfter: null }, { sendAfter: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: 50,
    select: { id: true, kind: true, phone: true, groupId: true, text: true, purpose: true, createdAt: true },
  })) as PlatformJobRow[];
  if (rows.length === 0) return [];

  const leaveGroups = [...new Set(rows.filter((r) => r.kind === "leave-group" && r.groupId).map((r) => r.groupId as string))];
  const approved = leaveGroups.length
    ? await db.organisation.findMany({
        where: { ...APPROVED_CLUB_WHERE, whatsappGroupId: { in: leaveGroups } },
        select: { whatsappGroupId: true },
      })
    : [];
  const approvedGroupIds = new Set(
    approved.map((o) => o.whatsappGroupId).filter((g): g is string => typeof g === "string"),
  );

  const adminLinked = leaveGroups.length
    ? ((await db.organisation.findMany({
        where: { adminGroupId: { in: leaveGroups } },
        select: { adminGroupId: true },
      })) ?? [])
    : [];
  const adminGroupIds = new Set(
    adminLinked.map((o) => o.adminGroupId).filter((g): g is string => typeof g === "string"),
  );

  const plan = planPlatformDispatch(rows, {
    now,
    approvedGroupIds,
    adminGroupIds,
    limit: opts.limit ?? MAX_JOBS_PER_POLL,
  });

  for (const r of plan.refuse) {
    console.warn(`[platform-jobs] job ${r.id} not dispatched: ${r.reason}`);
    await db.platformJob.updateMany({
      where: { id: r.id, status: "queued" },
      data: { status: "failed", failedAt: now, failReason: r.reason.slice(0, FAIL_REASON_MAX) },
    });
  }

  const out: PlatformJobInstruction[] = [];
  for (const job of plan.dispatch) {
    // The claim. updateMany on status = queued is the compare-and-set: the
    // loser of a race sees count 0 and does not dispatch.
    const { count } = await db.platformJob.updateMany({
      where: { id: job.id, status: "queued" },
      data: { status: "claimed", claimedAt: now },
    });
    if (count === 1) out.push(job.instruction);
  }
  return out;
}

// ── Outcomes ────────────────────────────────────────────────────────────

export type PlatformJobOutcome =
  | { outcome: "sent"; waMessageId?: string }
  | { outcome: "failed"; reason: string }
  | { outcome: "release" }
  | { outcome: "unconfirmed"; reason: string };

/**
 * Record what happened to a claimed job. Only a CLAIMED job moves, so a
 * replayed or late report changes nothing (`updated: false`).
 */
export async function recordPlatformJobOutcome(
  id: string,
  result: PlatformJobOutcome,
  now: Date = new Date(),
): Promise<{ updated: boolean }> {
  let data: Record<string, unknown>;
  switch (result.outcome) {
    case "sent":
      data = { status: "sent", sentAt: now, waMessageId: result.waMessageId ?? null };
      break;
    case "failed":
      data = {
        status: "failed",
        failedAt: now,
        failReason: (result.reason || "no reason given").slice(0, FAIL_REASON_MAX),
      };
      break;
    case "release":
      data = { status: "queued", claimedAt: null };
      break;
    case "unconfirmed":
      data = { status: "unconfirmed", failReason: (result.reason || "unconfirmed").slice(0, FAIL_REASON_MAX) };
      break;
  }
  const { count } = await db.platformJob.updateMany({ where: { id, status: "claimed" }, data });
  if (result.outcome === "failed" && count > 0) {
    console.error(`[platform-jobs] job ${id} FAILED on the Pi: ${result.reason}`);
  }
  return { updated: count > 0 };
}
