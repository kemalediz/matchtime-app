/**
 * PICTURE READING: the database half of `picture-reading.ts`.
 *
 * The daily picture cap needs no new table. Each read claims one
 * `SentNotification` row keyed `picture-read:<orgId>:<London day>:<message id>`
 * (the key is unique, so a retry of the same message cannot claim twice),
 * and today's count is the number of keys with that day's prefix. The row
 * holds no picture, no caption and no transcript.
 */
import { ORDINARY_MEMBER_WHERE } from "@/lib/guest-membership";
import { db } from "./db";
import { servingClubWhere } from "./club-approval";
import { resolveSenderUserIds } from "./admin-group-link";
import { withOrgAiBudget } from "./ai-budget";
import { anthropicModel, type PipelineModel } from "./pipeline/llm";
import type { PictureDeps, PictureSender } from "./picture-reading";

export const PICTURE_CLAIM_KIND = "picture-read";

export function pictureClaimKey(orgId: string, day: string, waMessageId: string): string {
  return `${PICTURE_CLAIM_KIND}:${orgId}:${day}:${waMessageId}`;
}

export function prismaPictureDeps(model: PipelineModel = anthropicModel()): PictureDeps {
  return {
    async findClub(groupId) {
      return db.organisation.findFirst({
        // The club's live players' group. A club setting up, muted or
        // paused has its bot off or is not serving: nothing is read.
        where: { whatsappGroupId: groupId, whatsappBotEnabled: true, ...servingClubWhere() },
        select: { id: true },
      });
    },

    async isOwnerOrAdmin(orgId: string, sender: PictureSender) {
      const ids = await resolveSenderUserIds({
        phones: [sender.senderPhone, sender.senderAltPhone],
        lid: sender.senderLid ?? null,
      });
      if (ids.length === 0) return false;
      const m = await db.membership.findFirst({
        where: { orgId, userId: { in: ids }, leftAt: null, role: { in: ["OWNER", "ADMIN"] }, ...ORDINARY_MEMBER_WHERE },
        select: { userId: true },
      });
      return !!m;
    },

    async isMember(orgId: string, sender: PictureSender) {
      const ids = await resolveSenderUserIds({
        phones: [sender.senderPhone, sender.senderAltPhone],
        lid: sender.senderLid ?? null,
      });
      if (ids.length === 0) return false;
      const m = await db.membership.findFirst({
        where: { orgId, userId: { in: ids }, leftAt: null, ...ORDINARY_MEMBER_WHERE },
        select: { userId: true },
      });
      return !!m;
    },

    readsToday(orgId, day) {
      return db.sentNotification.count({ where: { key: { startsWith: `${PICTURE_CLAIM_KIND}:${orgId}:${day}:` } } });
    },

    async claim(orgId, day, waMessageId) {
      try {
        await db.sentNotification.create({ data: { key: pictureClaimKey(orgId, day, waMessageId), kind: PICTURE_CLAIM_KIND } });
        return true;
      } catch (err) {
        if ((err as { code?: string })?.code === "P2002") return false;
        throw err;
      }
    },

    async unclaim(orgId, day, waMessageId) {
      await db.sentNotification.deleteMany({ where: { key: pictureClaimKey(orgId, day, waMessageId) } });
    },

    withBudget: (orgId, fn) => withOrgAiBudget(orgId, fn),
    model,
  };
}
