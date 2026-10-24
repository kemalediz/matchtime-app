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
 *   pool-code-reply     any number, because it only ever ANSWERS that
 *                       number's own DM: "that sign-up code did not work"
 *                       to whoever just sent a /play code that named
 *                       nothing (local player pool, slice L2). Queued only
 *                       by src/lib/pool/confirm.ts, rate-limited there per
 *                       number (src/lib/pool/rules.ts POOL_CONFIRM), never
 *                       to a number that did not write first
 *                       (`platform-jobs-source-guard.test.ts`).
 *   pool-welcome        only a number MatchTime already knows: the person
 *                       whose own message just confirmed his sign-up (his
 *                       User exists by then).
 *   connect-reply,      only a number MatchTime already knows (a User with
 *   organiser-decision, that phone: a verified sign-up or a club member).
 *   billing,
 *   setup-learned,
 *   setup-ask,
 *   setup-admin-code,
 *   setup-reminder,
 *   setup-reply
 *   pool-offer,         only a number MatchTime already knows: a pool
 *   pool-placed,        player whose own WhatsApp message confirmed his
 *   pool-reply,         sign-up (local player pool, slice L5a). Queued only
 *   pool-paused         by src/lib/pool/ (round.ts, accept.ts, reply.ts).
 *                       A `pool-offer` is ADMITTED at dispatch under the
 *                       platform cap's lock (`pool/dispatch.ts`): switches,
 *                       his caps and quiet hours are re-checked there.
 *   owner-approval,     NEVER through here. `queueOwnerDm` (owner-dm.ts)
 *   owner-ack,          is the only door to Kemal's phone.
 *   owner-setup-stuck
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
import { POOL_OFFER_PURPOSE, admitPoolOfferJobs, onPoolOfferJobFailed, onPoolOfferJobSent } from "./pool/dispatch";

// ── Vocabulary ──────────────────────────────────────────────────────────

/** DM purposes anything may queue, subject to the recipient rule above. */
/** "billing": club fee DMs to the billing contact or card holder (club fee
 *  billing, slice B3), queued only by `queueBillingDm` in club-billing.ts. */
/** "setup-learned" (F3, 2026-10-05): the organiser's one DM about the
 *  settings MatchTime set up from the group chat (src/lib/setup-learning). */
/** "setup-ask" (go-live slice S3, 2026-10-12): the organiser's ONE setup DM
 *  for a club held until they say GO (src/lib/club-setup-dm.ts). */
/** "setup-reply" (go-live slice S4, 2026-10-12): MatchTime's answer to a DM
 *  from an owner or admin of a club that is approved but still setting up
 *  (GO, help, "not recognised"). The club's own channel is off until GO,
 *  so these cannot be BotJobs. Queued only by src/lib/setup-go-dm.ts and,
 *  for help, src/lib/dm-help.ts; always a reply to the person's own DM. */
/** "setup-admin-code" (go-live slice S7, 2026-10-12): the setup DM's second
 *  message, exactly the admin group link command, queued with the setup DM
 *  in one transaction (src/lib/club-setup-dm.ts). */
/** "setup-reminder" (go-live slice S6, 2026-10-12): the ONE reminder, 24
 *  hours after the setup DM was due, to an organiser who has not gone live
 *  (src/lib/club-setup-reminder.ts). */
/** "setup-removed" (go-live removal slice, 2026-10-12): the organiser's one
 *  DM per removal when MatchTime is taken out of the group of a club that
 *  is still setting up. Queued only by src/lib/club-setup-removal.ts, and
 *  taken back by it if MatchTime is added back before it has gone. */
/** "setup-owner-live" (setup-hold switch-on fixes, 2026-10-13): the
 *  organiser's one DM when the MatchTime team took their club live for
 *  them ("Go live now" on the clubs page). Queued only by
 *  src/lib/club-setup-owner-live.ts, once per club. */
export const PLATFORM_DM_PURPOSES = [
  "otp",
  "connect-reply",
  "organiser-decision",
  "billing",
  "setup-learned",
  "setup-ask",
  "setup-admin-code",
  "setup-reminder",
  "setup-reply",
  "setup-removed",
  "setup-owner-live",
  "pool-welcome",
  "pool-code-reply",
  "pool-offer",
  "pool-placed",
  "pool-reply",
  "pool-paused",
] as const;
export type PlatformDmPurpose = (typeof PLATFORM_DM_PURPOSES)[number];

/** DM purposes that may go to a number no User has (see the header): a
 *  sign-up code, and the reply to a /play code that named nothing. */
const ANY_NUMBER_PURPOSES = ["otp", "pool-code-reply"] as const;

/** DM purposes only `queueOwnerDm` may write. */
/** "owner-setup-stuck" (go-live slice S6, 2026-10-12): ONE note per club
 *  that is still setting up 72 hours after its approval. An action item,
 *  not an alert: the owner can press "Go live now" on the clubs page
 *  (src/lib/club-setup-stuck.ts). */
export const OWNER_DM_PURPOSES = ["owner-approval", "owner-ack", "owner-setup-stuck"] as const;
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

/** Rows read per class (codes, everything else) on one poll. */
const DUE_READ_LIMIT = 50;

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

/** Why a DM was refused, as a code that is safe to log and to show: it
 *  never carries the number, the text or a name (`reason` may). */
export type PlatformDmRefusalCode =
  | "owner-purpose"
  | "unknown-purpose"
  | "not-a-phone-number"
  | "empty-text"
  | "number-not-known";

export class PlatformDmRefused extends Error {
  override readonly name = "PlatformDmRefused";
  constructor(
    readonly reason: string,
    readonly code: PlatformDmRefusalCode = "unknown-purpose",
  ) {
    super(`[platform-jobs] DM refused: ${reason}`);
  }
}

/** E.164 digits without "+", or null. Lives in phone.ts (no database), so
 *  pure modules can share it; re-exported here for its existing callers. */
export const platformPhoneDigits = e164Digits;

/** The two calls `queuePlatformDm` makes: `db`, or a transaction client. */
export type PlatformDmClient = {
  user: { findFirst(args: { where: { phoneNumber: string }; select: { id: true } }): Promise<{ id: string } | null> };
  platformJob: { create(args: { data: Record<string, unknown> }): Promise<{ id: string }> };
};

/**
 * Queue a DM on the platform channel. Throws `PlatformDmRefused` when the
 * recipient rule says no; the caller decides what the person sees.
 *
 * `client`: a transaction client, when the job must be created in the
 * caller's own transaction (the setup DM and its once-per-club stamp,
 * club-setup-dm.ts). Absent, `db`, exactly as before.
 *
 * `createdAt`: only for a caller that queues TWO DMs in one transaction
 * and needs them sent in a fixed order (the setup DM, then its admin group
 * command). Dispatch is oldest first by `createdAt`, and two rows created
 * in one transaction would otherwise share the database's transaction
 * timestamp. Absent, the database default, exactly as before.
 */
export async function queuePlatformDm(args: {
  phone: string;
  text: string;
  purpose: PlatformDmPurpose;
  refId?: string | null;
  sendAfter?: Date | null;
  client?: PlatformDmClient;
  createdAt?: Date;
}): Promise<{ id: string }> {
  const client = args.client ?? (db as unknown as PlatformDmClient);
  const purpose = args.purpose as string;
  if ((OWNER_DM_PURPOSES as readonly string[]).includes(purpose)) {
    throw new PlatformDmRefused(`"${purpose}" DMs go through queueOwnerDm (src/lib/owner-dm.ts) only`, "owner-purpose");
  }
  if (!(PLATFORM_DM_PURPOSES as readonly string[]).includes(purpose)) {
    throw new PlatformDmRefused(`unknown purpose "${purpose}"`, "unknown-purpose");
  }
  const digits = platformPhoneDigits(args.phone);
  if (!digits) throw new PlatformDmRefused(`not a phone number: ${JSON.stringify(args.phone)}`, "not-a-phone-number");
  const text = typeof args.text === "string" ? args.text : "";
  if (!text.trim()) throw new PlatformDmRefused("empty text", "empty-text");

  if (!(ANY_NUMBER_PURPOSES as readonly string[]).includes(purpose)) {
    // Rule 12: MatchTime never messages a number it does not already know.
    const known = await client.user.findFirst({ where: { phoneNumber: `+${digits}` }, select: { id: true } });
    if (!known) throw new PlatformDmRefused(`${purpose}: no MatchTime user has this number`, "number-not-known");
  }

  const row = await client.platformJob.create({
    data: {
      kind: "dm",
      phone: digits,
      text,
      purpose,
      refId: args.refId ?? null,
      status: "queued",
      sendAfter: args.sendAfter ?? null,
      ...(args.createdAt ? { createdAt: args.createdAt } : {}),
    },
  });
  return { id: row.id };
}

/** DM purposes `cancelQueuedPlatformDms` will touch. A sign-up code, a
 *  decision, a billing notice and anything for the owner are never
 *  cancelled from here. */
export const CANCELLABLE_DM_PURPOSES = ["setup-ask", "setup-admin-code", "setup-reminder", "setup-removed", "pool-offer"] as const;
export type CancellableDmPurpose = (typeof CANCELLABLE_DM_PURPOSES)[number];

/** How a cancelled job's `failReason` starts. On a CLAIMED job it is the
 *  mark that makes a later release fail the job instead of re-queueing it. */
export const CANCELLED_REASON_PREFIX = "cancelled: ";

/**
 * Cancel DMs that have not gone yet, because what they say is no longer
 * true: every job whose purpose is one of `purposes` AND whose refId is
 * one of `refIds` (a club's setup DM, its admin group command and its
 * reminder are three purposes with three refIds, cancelled together). There is no "cancelled" status: like a
 * job refused at dispatch, a cancelled job is `failed` with its
 * `failReason` ("cancelled: <reason>"), which `claimDuePlatformJobs` never
 * hands out and nothing retries.
 *
 * ONE STATEMENT, so it cannot interleave with the Pi (the claim and the
 * outcome report are single statements on the same row, and each waits
 * for the other and then re-checks its own WHERE):
 *   - a job still QUEUED (typically held for 09:00 London) becomes
 *     `failed`: it is never handed out. Counted in `cancelled`;
 *   - a job the Pi has already CLAIMED may be on its way, so its status is
 *     left alone, and it is MARKED: its `failReason` is set to the
 *     cancellation. If the Pi then RELEASES it (its one-DM-a-minute
 *     pacing held it back), `recordPlatformJobOutcome` fails it instead of
 *     putting it back in the queue, so it is not sent on a later poll. If
 *     the Pi sent it, it is `sent` and the mark says it was cancelled too
 *     late. Counted in `alreadyClaimed`.
 * Nothing else is touched: not a sent, failed or unconfirmed job, not
 * another purpose, not another refId.
 */
export async function cancelQueuedPlatformDms(args: {
  purposes: readonly CancellableDmPurpose[];
  refIds: readonly string[];
  reason: string;
  now?: Date;
}): Promise<{
  cancelled: number;
  alreadyClaimed: number;
  /** The same two counts for each purpose that had a job to act on. */
  byPurpose: Partial<Record<CancellableDmPurpose, { cancelled: number; alreadyClaimed: number }>>;
}> {
  const purposes = [...args.purposes] as string[];
  const refIds = [...args.refIds];
  for (const purpose of purposes) {
    if (!(CANCELLABLE_DM_PURPOSES as readonly string[]).includes(purpose)) {
      throw new Error(`[platform-jobs] "${purpose}" DMs cannot be cancelled`);
    }
  }
  if (purposes.length === 0 || refIds.length === 0 || refIds.some((r) => typeof r !== "string" || !r.trim())) {
    throw new Error("[platform-jobs] a cancel names at least one purpose and one refId");
  }
  const now = args.now ?? new Date();
  const reason = `${CANCELLED_REASON_PREFIX}${args.reason}`.slice(0, FAIL_REASON_MAX);
  // RETURNING reads the row AFTER the update: "failed" was queued,
  // "claimed" was claimed and is now marked.
  const rows = await db.$queryRaw<Array<{ status: string; purpose: string }>>`
    UPDATE "PlatformJob" SET
      "status" = CASE WHEN "status" = 'queued' THEN 'failed' ELSE "status" END,
      "failedAt" = CASE WHEN "status" = 'queued' THEN ${now} ELSE "failedAt" END,
      "failReason" = ${reason},
      "updatedAt" = ${now}
    WHERE "kind" = 'dm' AND "purpose" = ANY(${purposes}) AND "refId" = ANY(${refIds})
      AND "status" IN ('queued', 'claimed')
    RETURNING "status", "purpose"`;
  const byPurpose: Partial<Record<CancellableDmPurpose, { cancelled: number; alreadyClaimed: number }>> = {};
  for (const r of rows) {
    const counts = (byPurpose[r.purpose as CancellableDmPurpose] ??= { cancelled: 0, alreadyClaimed: 0 });
    if (r.status === "failed") counts.cancelled++;
    else if (r.status === "claimed") counts.alreadyClaimed++;
  }
  return {
    cancelled: rows.filter((r) => r.status === "failed").length,
    alreadyClaimed: rows.filter((r) => r.status === "claimed").length,
    byPurpose,
  };
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
  opts: { now?: Date; limit?: number; kinds?: PlatformJobKind[]; env?: Record<string, string | undefined> } = {},
): Promise<PlatformJobInstruction[]> {
  const now = opts.now ?? new Date();
  const kinds = opts.kinds ?? ["dm", "leave-group"];
  // ── Two reads, so a sign-up code can never be starved (PR #234 review,
  //    fix 1c) ──
  // One read of "the 50 oldest", ranked afterwards, hid a new code behind
  // any backlog of more than 50 older DMs until its ten minutes were up.
  // Codes are therefore read on their own, and everything else beside
  // them; `planPlatformDispatch` still puts codes first and keeps each
  // class oldest first, and the batch limit is applied there as before.
  const due = {
    status: "queued",
    kind: { in: kinds },
    OR: [{ sendAfter: null }, { sendAfter: { lte: now } }],
  };
  const read = (purpose: "otp" | { not: "otp" }) =>
    db.platformJob.findMany({
      where: { ...due, purpose },
      orderBy: { createdAt: "asc" },
      take: DUE_READ_LIMIT,
      select: { id: true, kind: true, phone: true, groupId: true, text: true, purpose: true, createdAt: true },
    }) as Promise<PlatformJobRow[]>;
  const [codes, others] = await Promise.all([read("otp"), read({ not: "otp" })]);
  const seen = new Set<string>();
  const read0 = [...(codes ?? []), ...(others ?? [])].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  if (read0.length === 0) return [];
  // Pool offers (local player pool L5a, `pool/dispatch.ts`) are not
  // planned here: they take the poll's room LEFT after everything else,
  // and are admitted AND claimed under the platform cap's lock.
  const poolRows = read0.filter((r) => r.purpose === POOL_OFFER_PURPOSE && r.kind === "dm");
  const rows = read0.filter((r) => !(r.purpose === POOL_OFFER_PURPOSE && r.kind === "dm"));

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
  const room = Math.max(0, (opts.limit ?? MAX_JOBS_PER_POLL) - plan.dispatch.length);
  if (poolRows.length > 0 && room > 0) {
    const { claimed } = await admitPoolOfferJobs(
      poolRows.map((r) => r.id),
      { now, limit: room, env: opts.env },
    );
    for (const r of poolRows) {
      if (claimed.has(r.id) && r.phone && r.text) out.push({ id: r.id, kind: "dm", phone: r.phone, text: r.text, purpose: r.purpose });
    }
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
  // A job CANCELLED while the Pi held it (`cancelQueuedPlatformDms`
  // marked it) is never put back in the queue. The release itself skips a
  // marked job (for every other job, which is every job there has ever
  // been, it is the one statement it always was); a marked job is then
  // failed instead. Each is one compare-and-set, so a cancel arriving in
  // between finds the job queued and fails it itself.
  const notCancelled = { OR: [{ failReason: null }, { NOT: { failReason: { startsWith: CANCELLED_REASON_PREFIX } } }] };
  const { count } = await db.platformJob.updateMany({
    where: { id, status: "claimed", ...(result.outcome === "release" ? notCancelled : {}) },
    data,
  });
  if (count === 0 && result.outcome === "release") {
    const cancelled = await db.platformJob.updateMany({
      where: { id, status: "claimed", failReason: { startsWith: CANCELLED_REASON_PREFIX } },
      data: { status: "failed", failedAt: now },
    });
    if (cancelled.count > 0) {
      console.log(`[platform-jobs] job ${id} was cancelled while claimed; released by the Pi, so failed instead of re-queued`);
      return { updated: true };
    }
  }
  // A pool offer reached him only when the Pi says so (review of #400, M3).
  if ((result.outcome === "sent" || result.outcome === "unconfirmed") && count > 0) await onPoolOfferJobSent(id, now);
  if (result.outcome === "failed" && count > 0) {
    console.error(`[platform-jobs] job ${id} FAILED on the Pi: ${result.reason}`);
    // A pool offer that never reached him ends cancelled (L5a).
    await onPoolOfferJobFailed(id, now);
  }
  return { updated: count > 0 };
}
