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
 *
 * Removal slice (2026-10-12): the group of a club that is APPROVED BUT
 * STILL SETTING UP (silent, so the Pi reports the removal). Billing answers
 * "setting-up" for it; `handleSetupRemoval` (lib/club-setup-removal.ts)
 * then stamps the removal, so the club cannot go live (and no free period
 * starts) until MatchTime is back, takes back a setup DM that has not gone,
 * deletes the chat captured at the add, records one event for the platform
 * owner and sends the organiser one DM in the daytime. The club stays
 * approved and setting up; nothing is said in the group. `setup` in the
 * answer says which: "removed" or "already-removed".
 */
import { NextResponse } from "next/server";
import { handleBotRemoved } from "@/lib/group-add";
import { handleAdminGroupRemoved } from "@/lib/admin-group-link";
import { selfJoinEnabledForApiRequest } from "@/lib/self-join-flag";
import { billingEnabledForApiRequest } from "@/lib/billing-flag";
import { handleBillingRemoval, removalAnswer } from "@/lib/club-billing-removal";
import { handleSetupRemoval } from "@/lib/club-setup-removal";

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
    // A club that is approved but still SETTING UP has no billing to pause
    // (billing answers "setting-up" and writes nothing). The removal itself
    // is recorded here: the club cannot go live, and so no free period can
    // start, until MatchTime is added back; its organiser is told once.
    // Whatever the self-join and billing switches say.
    if (billing.kind === "logged" && billing.why === "setting-up") {
      const setup = await handleSetupRemoval(groupId);
      return NextResponse.json({ ok: true, billing: removalAnswer(billing), setup: setup.kind, orgId: billing.orgId });
    }
    return NextResponse.json({ ok: true, billing: removalAnswer(billing), orgId: billing.orgId });
  }
  if (!selfJoinEnabledForApiRequest(request)) {
    return NextResponse.json({ ok: true, ignored: "self-join-disabled" });
  }
  const result = await handleBotRemoved(groupId);
  return NextResponse.json({ ok: true, ...result });
}
