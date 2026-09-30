/**
 * A MESSAGE IN A CLUB'S ADMIN GROUP (slice 2a, 2026-09-30).
 * Plan: MDs/friday-group-features-plan-2026-09-30.md, sections 2.5 and 2.8.
 *
 * The Pi forwards every message in a linked admin group here at once,
 * flagged `channel: "admin-group"`, and never into the analysis history or
 * the analyze batch. In slice 2a there is nothing in an admin group for
 * MatchTime to act on, so every message is acknowledged and ignored: no
 * reply, no write, and NO MODEL, ever. Slice 2b reads the organisers'
 * picks here (numbers, names, tags, ALL, NONE, YES, only while a pick is
 * open), still without a model.
 *
 * This module and its route import nothing that can reach a model;
 * `admin-group-no-model.source.test.ts` pins that.
 */
import { db } from "./db";

export interface AdminGroupMessage {
  groupId: string;
  messageId?: string | null;
  text: string;
  senderPhone?: string | null;
  senderLid?: string | null;
  senderAltPhone?: string | null;
  timestamp?: string | null;
}

export type AdminGroupMessageResult =
  | { handled: false; ignored: "not-an-admin-group"; replyText: null }
  | { handled: false; ignored: "no-open-pick"; orgId: string; replyText: null };

export async function handleAdminGroupMessage(msg: AdminGroupMessage): Promise<AdminGroupMessageResult> {
  const org = await db.organisation.findFirst({ where: { adminGroupId: msg.groupId }, select: { id: true } });
  if (!org) return { handled: false, ignored: "not-an-admin-group", replyText: null };
  // Slice 2b: the pick rounds. Until then nothing is ever open.
  return { handled: false, ignored: "no-open-pick", orgId: org.id, replyText: null };
}
