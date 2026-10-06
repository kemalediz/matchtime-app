/**
 * Bot-forwarded WhatsApp `group_leave` event. Marks the Membership as
 * left (preserves attendance/rating history) and notifies every org
 * admin via BotJob DM.
 *
 * Flow per recipient phone:
 *   1. Find org by whatsappGroupId.
 *   2. Normalise phone.
 *   3. Find User by phone. If not found, silent noop.
 *   4. Find Membership for (user, org). If not found or already leftAt,
 *      silent noop.
 *   5. Set Membership.leftAt = now.
 *   6. Queue BotJob DM to every admin: "<name|phone> left the group."
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import { sendAdminNotice } from "@/lib/admin-channel";

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const { groupId, phones } = (body ?? {}) as {
    groupId?: string;
    phones?: string[];
  };

  if (!groupId || !Array.isArray(phones) || phones.length === 0) {
    return NextResponse.json(
      { error: "groupId and non-empty phones[] required" },
      { status: 400 },
    );
  }

  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: groupId, whatsappBotEnabled: true },
    select: { id: true, name: true },
  });
  if (!org) {
    return NextResponse.json({ ok: true, ignored: "unknown-or-disabled-group" });
  }

  const now = new Date();

  type Result = {
    phone: string;
    marked: boolean;
    skipped?: string;
    userId?: string;
  };
  const results: Result[] = [];

  for (const raw of phones) {
    const normalised = normalisePhone(raw);
    if (!normalised) {
      results.push({ phone: raw, marked: false, skipped: "bad-phone" });
      continue;
    }

    const user = await db.user.findUnique({
      where: { phoneNumber: normalised },
      select: { id: true, name: true },
    });
    if (!user) {
      results.push({ phone: normalised, marked: false, skipped: "unknown-user" });
      continue;
    }

    const membership = await db.membership.findUnique({
      where: { userId_orgId: { userId: user.id, orgId: org.id } },
      select: { id: true, leftAt: true, role: true },
    });
    if (!membership) {
      results.push({ phone: normalised, marked: false, userId: user.id, skipped: "no-membership" });
      continue;
    }
    if (membership.leftAt) {
      results.push({ phone: normalised, marked: false, userId: user.id, skipped: "already-left" });
      continue;
    }

    await db.membership.update({
      where: { id: membership.id },
      data: { leftAt: now },
    });

    // Tell the admins the roster shrank, through the club's admin channel
    // (slice 2a, 2026-09-30). "each-admin" (Sutton FC) is today's DMs.
    {
      const displayName = user.name?.trim() || normalised;
      const wasAdmin = membership.role === "OWNER" || membership.role === "ADMIN";
      const lines = [
        `👋 *${displayName}* left *${org.name}*'s WhatsApp group${wasAdmin ? " (was an admin)" : ""}.`,
        ``,
        `They've been marked inactive on the roster. History is preserved: ratings and attendance stay attributed.`,
        ``,
        `If this was a mistake, re-add them to the group and I'll re-activate them automatically.`,
      ];
      const text = lines.join("\n");
      // An admin leaving is not DM'd about themselves.
      await sendAdminNotice({ orgId: org.id, holdOvernight: false, excludeUserId: user.id, text });
    }

    results.push({ phone: normalised, marked: true, userId: user.id });
  }

  return NextResponse.json({ ok: true, orgId: org.id, results });
}
