/**
 * The Pi received a GROUP INVITE by DM and asks whether to join it
 * (2026-10-15).
 *
 * WhatsApp refuses to let somebody who is not in MatchTime's contacts add
 * it to a group, and offers "Invite to group" instead. That sends MatchTime
 * a private invite message (`groupInviteMessage`). An organiser may also
 * paste the group's invite link. Either way the Pi posts:
 *   { phone?, senderAltPhone?, senderLid?, kind: "invite-message" | "invite-link" }
 * and joins ONLY on `{ accept: true }`. The rule (the organiser of an open,
 * DM-verified connect request on a draft club, by phone or by the connect
 * DM's LID) is lib/group-invite-rules.ts.
 *
 * Joining is all this answers. Once MatchTime is in the group the Pi's
 * ordinary bot-added flow runs, and /api/whatsapp/bot-added links the group
 * to the club exactly as for an add (the organiser is the inviter, and is
 * in the group).
 *
 * With SELF_JOIN_ENABLED off nothing is accepted. The answer never carries
 * a request id or a number, and nothing about the sender is logged.
 *
 * Auth via WHATSAPP_API_KEY same as the rest of /api/whatsapp/*.
 */
import { NextResponse } from "next/server";
import { checkGroupInviteSender } from "@/lib/group-invite";
import { selfJoinEnabledForApiRequest } from "@/lib/self-join-flag";

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const kind = body.kind === "invite-link" ? "invite-link" : "invite-message";
  if (!selfJoinEnabledForApiRequest(request)) {
    console.log(`[group-invite] ${kind}: not accepted (self-join is off)`);
    return NextResponse.json({ accept: false, reason: "self-join-off" });
  }
  try {
    const decision = await checkGroupInviteSender(body);
    if (decision.accept) {
      console.log(`[group-invite] ${kind}: accept (organiser of ${decision.connectId}, matched by ${decision.match})`);
      return NextResponse.json({ accept: true, match: decision.match });
    }
    console.log(`[group-invite] ${kind}: not accepted (${decision.reason})`);
    return NextResponse.json({ accept: false, reason: decision.reason });
  } catch (err) {
    console.error(`[group-invite] ${kind}: check failed: ${(err as Error)?.name ?? "error"}`);
    return NextResponse.json({ accept: false, reason: "error" }, { status: 500 });
  }
}
