/**
 * CAN MATCHTIME POST IN THIS GROUP? What one reading from the Pi does
 * (2026-10-14). POST /api/whatsapp/group-postability calls
 * `recordGroupPostability`; the rule is group-postability-rules.ts, the
 * table is group-postability-store.ts.
 *
 * The Pi reports a group's first reading in each process and every change
 * of it (whatsapp-bot/src/postability-report.ts), and refuses every group
 * send itself while MatchTime cannot post there
 * (whatsapp-bot/src/postability-gate.ts). The server's job is to make that
 * visible and to act on it:
 *
 *   a live club's group   cannot post: an open condition on the owner's
 *                         health page (`GROUP_POSTING_KIND`), and ONE
 *                         notice per stretch to the club's organisers
 *                         through their admin channel (never an ops DM to
 *                         the platform owner). Can post again: the
 *                         condition is resolved and the stretch cleared.
 *   a club's admin group  the same with `ADMIN_GROUP_POSTING_KIND`; while it
 *                         lasts admin notices go to the club's one person
 *                         by DM (admin-channel.ts reads `isGroupPostable`).
 *   a held connect add    can post now (MatchTime made admin): the link is
 *                         finished (`resumeHeldGroupAdd`, group-add.ts).
 *
 * Nothing is logged but group ids, club ids and booleans. Never throws.
 */
import { db } from "./db";
import { APPROVED_CLUB_WHERE } from "./club-approval-state";
import {
  adminGroupNotPostableText,
  decideGroupPostability,
  liveGroupNotPostableText,
  planPostStateChange,
  type PostabilityInput,
  type PostabilityReason,
} from "./group-postability-rules";
import { markNoticeSent, readPostState, writePostReading } from "./group-postability-store";
import { sendAdminNotice } from "./admin-channel";
import { resumeHeldGroupAdd, type ResumeOutcome } from "./group-add";

/** The health page condition: a live club's group MatchTime cannot post in. */
export const GROUP_POSTING_KIND = "group-not-postable";
/** The same for a club's linked admin group. */
export const ADMIN_GROUP_POSTING_KIND = "admin-group-not-postable";

export interface RecordResult {
  canPost: boolean;
  reason: PostabilityReason;
  stored: boolean;
  /** Clubs whose group (or admin group) this is, by role. */
  liveOrgs: number;
  adminOrgs: number;
  noticesQueued: number;
  resumed?: ResumeOutcome["kind"];
}

async function openCondition(orgId: string, kind: string, severity: "critical" | "warning", title: string, detail: string, now: Date) {
  try {
    const open = await db.opsAlert.findFirst({ where: { orgId, kind, resolvedAt: null }, select: { id: true } });
    if (open) {
      await db.opsAlert.update({ where: { id: open.id }, data: { severity, title, detail, lastSeenAt: now } });
      return;
    }
    await db.opsAlert.create({
      data: { orgId, kind, severity, title, detail, firstSeenAt: now, lastSeenAt: now, resolvedAt: null },
    });
  } catch (err) {
    console.error(`[group-postability] could not record ${kind} for org ${orgId}:`, err instanceof Error ? err.name : err);
  }
}

async function resolveCondition(orgId: string, kind: string, now: Date) {
  try {
    await db.opsAlert.updateMany({ where: { orgId, kind, resolvedAt: null }, data: { resolvedAt: now, lastSeenAt: now } });
  } catch (err) {
    console.error(`[group-postability] could not resolve ${kind} for org ${orgId}:`, err instanceof Error ? err.name : err);
  }
}

function why(reason: PostabilityReason): string {
  return reason === "community-announce"
    ? "it is a community announcements group and MatchTime is not an admin there"
    : "only admins can send messages there and MatchTime is not an admin";
}

export async function recordGroupPostability(args: {
  groupId: string;
  input: PostabilityInput;
  now?: Date;
}): Promise<RecordResult> {
  const { groupId, input } = args;
  const now = args.now ?? new Date();
  const decided = decideGroupPostability(input);
  const prev = await readPostState(groupId);
  const plan = planPostStateChange({
    prev: prev ? { canPost: prev.canPost, blockedSince: prev.blockedSince ?? null, noticeSentAt: prev.noticeSentAt ?? null } : null,
    canPost: decided.canPost,
    now,
  });
  const stored = await writePostReading({
    groupId,
    input,
    canPost: decided.canPost,
    blockedSince: plan.blockedSince,
    // `noticeSentAt` is kept when a stretch ends: the plan reads it to tell
    // a group's organisers at most once a day, however often it flaps.
    now,
  });
  const result: RecordResult = {
    canPost: decided.canPost,
    reason: decided.reason,
    stored,
    liveOrgs: 0,
    adminOrgs: 0,
    noticesQueued: 0,
  };
  // Nothing stored (no table yet): act on nothing, so nobody is told about
  // a stretch the server cannot remember telling them about.
  if (!stored) return result;

  let liveOrgs: Array<{ id: string; name: string; language: string | null }> = [];
  let adminOrgs: Array<{ id: string; name: string; language: string | null; adminGroupSubject: string | null }> = [];
  try {
    [liveOrgs, adminOrgs] = await Promise.all([
      db.organisation.findMany({
        where: { whatsappGroupId: groupId, ...APPROVED_CLUB_WHERE },
        select: { id: true, name: true, language: true },
      }),
      db.organisation.findMany({
        where: { adminGroupId: groupId },
        select: { id: true, name: true, language: true, adminGroupSubject: true },
      }),
    ]);
  } catch (err) {
    console.error(`[group-postability] ${groupId}: club lookup failed:`, err instanceof Error ? err.name : err);
  }
  result.liveOrgs = liveOrgs.length;
  result.adminOrgs = adminOrgs.length;

  if (decided.canPost) {
    for (const o of liveOrgs) await resolveCondition(o.id, GROUP_POSTING_KIND, now);
    for (const o of adminOrgs) await resolveCondition(o.id, ADMIN_GROUP_POSTING_KIND, now);
    if (prev?.heldConnectId) {
      try {
        result.resumed = (await resumeHeldGroupAdd(groupId, now)).kind;
      } catch (err) {
        console.error(`[group-postability] ${groupId}: finishing the held add failed:`, err instanceof Error ? err.name : err);
      }
    }
  } else {
    const blockedReason = decided.reason as Exclude<PostabilityReason, "ok">;
    for (const o of liveOrgs) {
      await openCondition(
        o.id,
        GROUP_POSTING_KIND,
        "critical",
        "MatchTime cannot post in the club's group",
        `Since ${(plan.blockedSince ?? now).toISOString()}: ${why(blockedReason)}. Group posts are skipped until it can post again.`,
        now,
      );
      if (plan.noticeDue) {
        await sendAdminNotice({ orgId: o.id, text: liveGroupNotPostableText(o.language, { club: o.name, reason: blockedReason }) });
        result.noticesQueued++;
      }
    }
    for (const o of adminOrgs) {
      await openCondition(
        o.id,
        ADMIN_GROUP_POSTING_KIND,
        "warning",
        "MatchTime cannot post in the club's admin group",
        `Since ${(plan.blockedSince ?? now).toISOString()}: ${why(blockedReason)}. Admin notices go by DM meanwhile.`,
        now,
      );
      if (plan.noticeDue) {
        await sendAdminNotice({
          orgId: o.id,
          text: adminGroupNotPostableText(o.language, { club: o.name, group: o.adminGroupSubject ?? null }),
        });
        result.noticesQueued++;
      }
    }
    if (result.noticesQueued > 0) await markNoticeSent(groupId, now);
  }

  console.log(
    `[group-postability] ${groupId}: canPost=${decided.canPost} (${decided.reason}), ${result.liveOrgs} club(s), ` +
      `${result.adminOrgs} admin group(s), ${result.noticesQueued} notice(s)${result.resumed ? `, held add ${result.resumed}` : ""}`,
  );
  return result;
}
