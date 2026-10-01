/**
 * POST /api/whatsapp/bot-removed (self-join slice 6, 2026-09-29).
 * Plan: MDs/self-join-and-approval-plan-2026-09-28.md, section 5.7.
 *
 * The Pi saw MatchTime itself removed from a group in its silent set:
 *   { groupId }
 * A club waiting for approval goes back to draft (the organiser's card
 * offers the button again; the owner's pending item reads "removed"), and
 * an unsolicited group is marked left. No DMs to anyone.
 *
 * Only ever about silent groups: the Pi forwards nothing for a group a
 * live club owns, and the handler only reads requests whose club is
 * PENDING, so an approved club (Sutton FC) cannot be moved from here.
 *
 * Slice 2a (2026-09-30): also a club's linked ADMIN group, which is not
 * silent. That case is handled first and whatever the self-join switch.
 *
 * Behind SELF_JOIN_ENABLED. A Pi built before slice 6 never calls it; a
 * server built before it answers 404, which the Pi logs and ignores.
 *
 * Club fee billing, slice B5 (2026-10-01): the Pi now also forwards
 * MatchTime's removal from a LIVE (monitored) group, only when MatchTime
 * itself is among the removed participants. A group an APPROVED club owns
 * goes to `handleBillingRemoval` (lib/club-billing-removal.ts), whatever
 * the self-join switch says: a club being billed is paused (removed) and
 * its subscription set to end with the paid month, no DM; Sutton FC, an
 * exempt club and BILLING_ENABLED off are logged only. The answer's
 * `billing` word tells the Pi whether to stop monitoring the group. A
 * group no approved club owns carries on exactly as before.
 */
import { NextResponse } from "next/server";
import { handleBotRemoved } from "@/lib/group-add";
import { handleAdminGroupRemoved } from "@/lib/admin-group-link";
import { selfJoinEnabledForApiRequest } from "@/lib/self-join-flag";
import { billingEnabledForApiRequest } from "@/lib/billing-flag";
import { handleBillingRemoval, removalAnswer } from "@/lib/club-billing-removal";

export async function POST(request: Request) {
  if (request.headers.get("x-api-key") !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { groupId?: unknown } | null;
  const groupId = typeof body?.groupId === "string" && body.groupId.endsWith("@g.us") ? body.groupId : null;
  if (!groupId) return NextResponse.json({ error: "groupId required" }, { status: 400 });
  // Slice 2a: removed from a club's linked admin group. Whatever the
  // self-join switch says: the link is cleared, the club goes back to the
  // owner by DM, and the owner is told (L4).
  const adminGroup = await handleAdminGroupRemoved(groupId);
  if (adminGroup.unlinked) return NextResponse.json({ ok: true, adminGroup: "unlinked", orgId: adminGroup.orgId });
  // Slice B5: a live club's group. Whatever the self-join switch says.
  const billing = await handleBillingRemoval(groupId, { flagOn: billingEnabledForApiRequest(request) });
  if (billing.kind !== "no-club") {
    return NextResponse.json({ ok: true, billing: removalAnswer(billing), orgId: billing.orgId });
  }
  if (!selfJoinEnabledForApiRequest(request)) {
    return NextResponse.json({ ok: true, ignored: "self-join-disabled" });
  }
  const result = await handleBotRemoved(groupId);
  return NextResponse.json({ ok: true, ...result });
}
