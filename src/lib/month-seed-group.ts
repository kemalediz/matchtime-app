/**
 * The coming month's list, posted by an ORGANISER in the PLAYERS' group
 * before that month has been started (2026-10-29, Vets MNF: Davide posts
 * "List for November" and everybody adds their name). The same draft as
 * agent A's admin-group door (`month-seed-hq.ts`, `proposeMonthSeedPaste`)
 * and the web's "Start <month> from your list": the list as the monthly
 * reader (the model) read it, matched to players, stored as the proposal
 * that waits for an organiser's YES.
 *
 * MatchTime says NOTHING in the players' group. The organiser who posted it
 * gets the draft by DM and answers there in his own words: yes, no, or a
 * correction (`month-seed-reply.ts`); the organisers' group's YES and the
 * page work too.
 *
 * Null-safe: anything that does not fit (not an organiser, no coming month
 * to start, a list for another month) returns false and the caller goes on.
 */
import { db } from "./db";
import { t } from "./i18n/t";
import { loadClubQuietHours } from "./club-quiet-hours";
import { adminNoticeSendAfter } from "./rolling-squad-rules";
import type { MonthlyReading } from "./monthly-reader-prompt";
import { MONTH_SEED_DM_KIND, MONTH_SEED_DM_TTL_MS } from "./month-seed-reply";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

export async function proposeMonthSeedFromGroup(args: {
  orgId: string;
  reading: Extract<MonthlyReading, { kind: "list" }>;
  waMessageId: string;
  senderUserId: string | null;
  now?: Date;
}): Promise<boolean> {
  const now = args.now ?? new Date();
  if (!args.senderUserId || !args.reading.list.month || args.reading.listOf !== "month") return false;
  const [admin, org] = await Promise.all([
    db.membership.findFirst({
      where: { orgId: args.orgId, userId: args.senderUserId, leftAt: null, role: { in: ["OWNER", "ADMIN"] }, guestMatchId: null },
      select: { user: { select: { phoneNumber: true } } },
    }),
    db.organisation.findUnique({ where: { id: args.orgId }, select: { language: true, adminGroupId: true } }),
  ]);
  if (!admin || !org) return false;
  const { proposeMonthSeedPaste } = await import("./month-seed-read");
  const res = await proposeMonthSeedPaste({
    orgId: args.orgId,
    lang: org.language,
    messageId: args.waMessageId,
    organiserUserId: args.senderUserId,
    text: "",
    now,
    list: args.reading.list,
  });
  if (!res || res.outcome !== "month-seed-proposed" || !res.proposal) return false;
  const phone = admin.user.phoneNumber?.replace(/^\+/, "");
  // The draft waits for his answer by DM (`month-seed-reply.ts`) for a day,
  // not the half hour an answer in HQ gets.
  const proposal = await db.adminSquadProposal.findFirst({
    where: { orgId: args.orgId, waMessageId: args.waMessageId, resolvedAt: null },
    select: { id: true },
  });
  if (!proposal) return false;
  await db.adminSquadProposal.update({ where: { id: proposal.id }, data: { expiresAt: new Date(now.getTime() + MONTH_SEED_DM_TTL_MS) } });
  const text = t(org.language).mwk_dm_seed_from_group({ ...res.proposal, hq: !!org.adminGroupId });
  try {
    // The offer, with its words: what his DM answer is read against.
    await db.sentNotification.create({ data: { key: `org-${args.orgId}:month-seed-dm:${proposal.id}`, kind: MONTH_SEED_DM_KIND, text, targetUser: args.senderUserId } });
    if (phone) {
      const sendAfter = adminNoticeSendAfter(now, await loadClubQuietHours(args.orgId));
      await db.botJob.create({ data: { orgId: args.orgId, kind: "dm", phone, text, ...(sendAfter ? { sendAfter } : {}) } });
    }
  } catch (err) {
    if (!isUniqueViolation(err)) console.error("[month-seed-group] DM to the organiser failed:", err);
  }
  console.log(`[month-seed-group] ${args.waMessageId}: the coming month proposed from the players' group for ${args.orgId}, by DM`);
  return true;
}
