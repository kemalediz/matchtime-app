/**
 * THE GROUP-LEAVE POST (Kemal, 2026-10-31): who left a club's group and,
 * when the event says, WHO REMOVED THEM. The remover is resolved exactly
 * like the adder of a bot-added event (`resolveAdder`: the phone off the
 * event, else a LID re-resolved from the driver's local store, plus the LID
 * it was addressed by), so the server can mark a removal by one of the
 * club's organisers (`Membership.removedByOrganiserAt`) and leave a person
 * who left himself as he is. The Pi never decides who is an organiser.
 *
 * A notification without an author gives exactly the old payload, and the
 * server treats a payload without the remover fields as today.
 */
import type { GroupMembershipEvent, WaDriver } from "./driver.js";
import { resolveAdder } from "./bot-added.js";

export interface GroupLeavePost {
  groupId: string;
  phones: string[];
  /** The remover's phone (digits), when known. */
  removedByPhone?: string;
  /** The bare LID digits the remover was addressed by, when it was a LID. */
  removedByLid?: string;
}

/** Leaver phones: `@c.us` ids only (a LID we cannot read is dropped, as
 *  always), never MatchTime's own id. */
export function leaverPhones(recipientIds: readonly unknown[] | undefined, selfId: string | undefined): string[] {
  if (!Array.isArray(recipientIds)) return [];
  return recipientIds
    .map((r) => (typeof r === "string" ? r : ((r as { _serialized?: string })?._serialized ?? "")))
    .filter((id) => id.endsWith("@c.us"))
    .filter((id) => id !== selfId)
    .map((id) => id.replace("@c.us", "").replace(/^\+/, ""))
    .filter((p) => p.length > 0);
}

/** The post for a human leaving a monitored group, or null when there is
 *  nobody to report. Never throws (the remover is best effort). */
export async function groupLeavePost(
  driver: WaDriver,
  notification: GroupMembershipEvent,
  selfId: string | undefined,
): Promise<GroupLeavePost | null> {
  const groupId = notification.chatId;
  if (!groupId) return null;
  const phones = leaverPhones(notification.recipientIds, selfId);
  if (phones.length === 0) return null;
  const post: GroupLeavePost = { groupId, phones };
  try {
    const r = await resolveAdder(driver, notification);
    if (r.addedByPhone) post.removedByPhone = r.addedByPhone;
    if (r.addedByLid) post.removedByLid = r.addedByLid;
  } catch {
    /* no remover: today's payload */
  }
  return post;
}
