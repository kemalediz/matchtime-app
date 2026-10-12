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
import { goLiveClub, helloPreviewForClub, liveByOwner, liveByUser, parseLiveBy, type GoLiveResult } from "@/lib/club-setup";
import { tellOrganiserOwnerWentLive, type OwnerLiveDmOutcome } from "@/lib/club-setup-owner-live";
import { setupLearningUiEnabledForRequest } from "@/lib/setup-learning-ui-flag";

async function requireClubAdmin(orgId: string): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);
  return session.user.id;
}

/**
 * WHAT THE GO LIVE BUTTON GETS BACK (review of PR #236, fix 5): the
 * outcome and the words the banner shows, and nothing else. `GoLiveResult`
 * itself never leaves the server: its `liveBy` is a user id, and for the
 * MatchTime owner it is `owner:<that user's id>`.
 *
 * `already-live` says who by a display NAME for another owner or admin of
 * the club ("member"), "matchtime" for the MatchTime owner, and "you" when
 * it was the caller (a lost answer followed by a retry: fix 4).
 */
export type GoLiveActionResult =
  // AFTER GOING LIVE (PR #237, billing): `freePeriodNote` is the free
  // period sentence and the club fee tip, in the club's language, when the
  // club's free period started with this go-live; null when none did
  // (billing off, the Free plan, one already had). The same words the
  // WhatsApp "Done" reply carries. The banner shows it under the result.
  | { outcome: "went-live"; club: string; group: string; hello: string; freePeriodNote: string | null }
  | { outcome: "already-live"; club: string; by: "you" | "member" | "matchtime" | "unknown"; byName: string | null }
  | { outcome: "still-reading" }
  | { outcome: "removed-from-group"; club: string; group: string }
  | { outcome: "billing-paused"; club: string }
  | { outcome: "not-setting-up" };

async function forBrowser(r: GoLiveResult, callerId: string): Promise<GoLiveActionResult> {
  switch (r.outcome) {
    case "went-live":
      return { outcome: "went-live", club: r.club, group: r.group, hello: r.hello, freePeriodNote: r.freePeriodNote ?? null };
    case "already-live": {
      const who = parseLiveBy(r.liveBy);
      if (who?.kind === "matchtime") return { outcome: "already-live", club: r.club, by: "matchtime", byName: null };
      if (who?.kind === "user" && who.userId === callerId) return { outcome: "already-live", club: r.club, by: "you", byName: null };
      if (who?.kind === "user") {
        // The name only: never a phone number, an email or the id.
        const user = await db.user.findUnique({ where: { id: who.userId }, select: { name: true } });
        const name = user?.name?.trim() || null;
        if (name) return { outcome: "already-live", club: r.club, by: "member", byName: name };
      }
      return { outcome: "already-live", club: r.club, by: "unknown", byName: null };
    }
    case "removed-from-group":
      return { outcome: "removed-from-group", club: r.club, group: r.group };
    case "billing-paused":
      return { outcome: "billing-paused", club: r.club };
    case "still-reading":
      return { outcome: "still-reading" };
    case "not-setting-up":
      return { outcome: "not-setting-up" };
  }
}

/**
 * Take a club that is setting up live. The same outcomes as the WhatsApp
 * GO: "went-live", "already-live", "still-reading", "removed-from-group",
 * "billing-paused", "not-setting-up", shaped for the browser.
 */
export async function goLiveClubAction(orgId: string): Promise<GoLiveActionResult> {
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
  return forBrowser(result, userId);
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

/** What the owner is told about the organiser's DM. Owner-only English. */
const ORGANISER_TOLD: Record<OwnerLiveDmOutcome, string> = {
  queued: "The organiser is being told by WhatsApp.",
  already: "The organiser has already been told.",
  "no-organiser": "There is no organiser on record, so nobody was told.",
  refused: "The organiser could NOT be told: their number was refused.",
  failed: "The organiser could NOT be told: the message was not queued.",
};

function describeOwnerGoLive(r: GoLiveResult, told: OwnerLiveDmOutcome | null): OwnerGoLiveResult {
  switch (r.outcome) {
    case "went-live":
      return {
        ok: true,
        message:
          `${r.club} is live. The hello is on its way to "${r.group}". ` +
          (r.freePeriodStarted ? "Its free period started now." : "No free period started.") +
          (told ? ` ${ORGANISER_TOLD[told]}` : ""),
      };
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
 *
 * THE ORGANISER IS TOLD. They did not say GO, so nothing else tells them:
 * after a go-live that this call made, one DM goes to the organiser who
 * connected the club (`tellOrganiserOwnerWentLive`,
 * src/lib/club-setup-owner-live.ts), in the daytime, with the free period
 * note the writer returned. It never throws and never undoes the go-live;
 * what became of it is in the message the owner sees.
 */
export async function ownerGoLiveNowAction(orgId: string): Promise<OwnerGoLiveResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId || !(await isSuperadmin(userId))) throw new Error("Not allowed");
  const result = await goLiveClub(orgId, liveByOwner(userId), new Date(), {
    learningEnabled: await setupLearningUiEnabledForRequest(),
    skipReadingCheck: true,
  });
  const told = result.outcome === "went-live" ? await tellOrganiserOwnerWentLive(result) : null;
  revalidatePath("/admin/clubs");
  revalidatePath("/admin/settings");
  return describeOwnerGoLive(result, told);
}
// ════ END the MatchTime owner's "Go live now" ════
