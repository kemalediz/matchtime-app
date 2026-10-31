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
 *   5. Set Membership.leftAt = now, and `removedByOrganiserAt` too when
 *      the Pi named a remover who is an OWNER or ADMIN of this club and
 *      not the person himself (group-leave-rules.ts, 2026-10-31). An old
 *      Pi sends no remover: never marked, as before.
 *   6. Take him off the club's upcoming matches (member-removal.ts).
 *   7. Queue BotJob DM to every admin: "<name|phone> left the group."
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import { sendAdminNotice } from "@/lib/admin-channel";
import { takeRemovedMemberOffUpcomingMatches } from "@/lib/member-removal";
import { resolveSenderUserIds } from "@/lib/admin-group-link";
import { leaveIsOrganiserRemoval } from "@/lib/group-leave-rules";
import { ORDINARY_MEMBER_WHERE } from "@/lib/guest-membership";

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const { groupId, phones, removedByPhone, removedByLid } = (body ?? {}) as {
    groupId?: string;
    phones?: string[];
    /** Who removed them (Pi, 2026-10-31), when the event said. Optional:
     *  an older Pi sends neither, and nothing is marked (as before). */
    removedByPhone?: unknown;
    removedByLid?: unknown;
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

  // The remover, as MatchTime accounts, and this club's organisers: a
  // removal by one of them is stamped (group-leave-rules.ts).
  const removerPhone = typeof removedByPhone === "string" && removedByPhone.trim() ? removedByPhone : null;
  const removerLid = typeof removedByLid === "string" && removedByLid.trim() ? removedByLid : null;
  const removerUserIds = removerPhone || removerLid ? await resolveSenderUserIds({ phones: [removerPhone], lid: removerLid }) : [];
  const organiserUserIds = new Set(
    removerUserIds.length > 0
      ? (
          await db.membership.findMany({
            where: { orgId: org.id, userId: { in: removerUserIds }, leftAt: null, role: { in: ["OWNER", "ADMIN"] }, ...ORDINARY_MEMBER_WHERE },
            select: { userId: true },
          })
        ).map((m) => m.userId)
      : [],
  );

  type Result = {
    phone: string;
    marked: boolean;
    skipped?: string;
    userId?: string;
    removedByOrganiser?: boolean;
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

    const byOrganiser = leaveIsOrganiserRemoval({ removerUserIds, leaverUserId: user.id, organiserUserIds });
    await db.membership.update({
      where: { id: membership.id },
      data: byOrganiser ? { leftAt: now, removedByOrganiserAt: now } : { leftAt: now },
    });
    if (byOrganiser) console.log(`[group-leave] org=${org.id} user=${user.id}: removed by an organiser (${removerUserIds.join(",")})`);
    // Off every match of the club still to come (2026-10-24): a place held
    // for a player who is no longer in the group is printed nameless and
    // cannot be dropped by "X out". Past matches keep their history.
    await takeRemovedMemberOffUpcomingMatches({
      userId: user.id,
      orgId: org.id,
      now,
      event: { cause: "member-removed", actorKind: "system", sourceRef: "whatsapp:group-leave" },
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

    results.push({ phone: normalised, marked: true, userId: user.id, ...(byOrganiser ? { removedByOrganiser: true } : {}) });
  }

  return NextResponse.json({ ok: true, orgId: org.id, results });
}
