"use server";

/**
 * "I can't make it" on a friend link's page (2026-11-01). A server action
 * is a public endpoint: the signed token names the link, and the pull-out
 * runs only for the friend it booked, signed in as him (his booked DM
 * carries a signed link that signs him in and lands here). The rules and
 * writes are `src/lib/friend-link/withdraw.ts`.
 */
import { auth } from "@/lib/auth";
import { openFriendLink } from "@/lib/friend-link/page";
import { pullOutOfFriendPlace, type FriendPullOut } from "@/lib/friend-link/withdraw";

export async function pullOutFriendLinkAction(token: string): Promise<{ state: FriendPullOut }> {
  try {
    const userId = (await auth())?.user?.id ?? null;
    const opened = typeof token === "string" ? await openFriendLink(token) : null;
    if (!userId || !opened || opened.usedByUserId !== userId) return { state: "not-held" };
    return { state: await pullOutOfFriendPlace({ linkId: opened.id, userId }) };
  } catch (err) {
    console.error("[friend-link] the page's pull-out failed:", err instanceof Error ? err.message : "failed");
    return { state: "not-held" };
  }
}
