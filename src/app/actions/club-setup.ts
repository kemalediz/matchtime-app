"use server";

/**
 * GOING LIVE FROM THE WEBSITE (go-live slice S4, 2026-10-12). The Go live
 * button on the settings page, and the MatchTime owner's "Go live now" on
 * the clubs page, both end here. No UI in this slice: slice S5 builds the
 * banner and the buttons on top of these two actions.
 *
 * Each is a thin, admin-gated wrapper round the single writer,
 * `goLiveClub` (src/lib/club-setup.ts), the same one the organiser's GO by
 * WhatsApp calls, so the two doors can never disagree and a race between
 * them gives one hello: the loser is told "already-live".
 *
 * Gate: `requireOrgAdmin`, the check every other club action uses (a
 * current owner or admin of the club, or the MatchTime owner).
 *
 * "use server" modules may export async functions only (see
 * __tests__/platform-jobs-source-guard.test.ts).
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isSuperadmin, requireOrgAdmin } from "@/lib/org";
import { goLiveClub, helloPreviewForClub, liveByOwner, liveByUser, type GoLiveResult } from "@/lib/club-setup";
import { setupLearningUiEnabledForRequest } from "@/lib/setup-learning-ui-flag";

async function requireClubAdmin(orgId: string): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);
  return session.user.id;
}

/**
 * Take a club that is setting up live. Returns the same outcomes as the
 * WhatsApp GO: "went-live", "already-live" (with who and when),
 * "still-reading", "removed-from-group", "not-setting-up".
 */
export async function goLiveClubAction(orgId: string): Promise<GoLiveResult> {
  const userId = await requireClubAdmin(orgId);
  // The club's own owner or admin is recorded by user id. Anybody else who
  // passed the gate is the MatchTime owner acting for the club.
  const own = await db.membership.findFirst({
    where: { userId, orgId, leftAt: null, role: { in: ["OWNER", "ADMIN"] } },
    select: { id: true },
  });
  // The hello names whoever connected the club (the loader's default).
  // The options are written out here and take nothing from the caller:
  // this door can never skip the "still reading" block (owner decision 4).
  const result = await goLiveClub(orgId, own ? liveByUser(userId) : liveByOwner(userId), new Date(), {
    learningEnabled: await setupLearningUiEnabledForRequest(),
  });
  revalidatePath("/admin/settings");
  revalidatePath("/admin/clubs");
  return result;
}

/**
 * The hello this club's group would get if it went live now, for the
 * banner's preview. Built from the club's settings at this moment.
 */
export async function helloPreviewAction(orgId: string): Promise<string> {
  await requireClubAdmin(orgId);
  return helloPreviewForClub(orgId);
}

// ════ BEGIN the MatchTime owner's "Go live now" (slice S5, 2026-10-12) ════

/** What the owner's button shows: the same shape as the other buttons on
 *  /admin/clubs (`ClubActionResult`, actions/club-decisions.ts). */
export interface OwnerGoLiveResult {
  ok: boolean;
  message: string;
}

function describeOwnerGoLive(r: GoLiveResult): OwnerGoLiveResult {
  switch (r.outcome) {
    case "went-live":
      return { ok: true, message: `${r.club} is live. The hello is on its way to "${r.group}".` };
    case "already-live":
      return { ok: false, message: `${r.club} is already live.` };
    case "removed-from-group":
      return { ok: false, message: `MatchTime is not in "${r.group}" any more, so ${r.club} cannot go live.` };
    case "billing-paused":
      return { ok: false, message: `${r.club} is paused for the club fee, so it cannot go live yet.` };
    case "still-reading":
      return { ok: false, message: `${r.club} is still being read. Try again in a few minutes.` };
    case "not-setting-up":
      return { ok: false, message: "That club is not setting up, so there is nothing to take live." };
  }
}

/**
 * "Go live now" on /admin/clubs (owner decision 7): the MatchTime owner
 * takes a club that is stuck in setting up live.
 *
 * OWNER ONLY: `User.isSuperadmin`, checked here whatever the page showed.
 * An owner or admin of the club is refused; theirs is `goLiveClubAction`.
 *
 * The ONE caller of `skipReadingCheck`: it works while the chat reading is
 * unfinished. Recorded as `liveByOwner`. Every other refusal (removed from
 * the group, paused, already live) stands.
 */
export async function ownerGoLiveNowAction(orgId: string): Promise<OwnerGoLiveResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId || !(await isSuperadmin(userId))) throw new Error("Not allowed");
  const result = await goLiveClub(orgId, liveByOwner(userId), new Date(), {
    learningEnabled: await setupLearningUiEnabledForRequest(),
    skipReadingCheck: true,
  });
  revalidatePath("/admin/clubs");
  revalidatePath("/admin/settings");
  return describeOwnerGoLive(result);
}
// ════ END the MatchTime owner's "Go live now" ════
