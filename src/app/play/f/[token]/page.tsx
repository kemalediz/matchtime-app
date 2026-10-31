import type { Metadata } from "next";
import { openFriendLink } from "@/lib/friend-link/page";
import { PlaySignup } from "../../play-signup";
import { FriendLinkClosed } from "./friend-link-closed";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "MatchTime", robots: { index: false, follow: false } };

/**
 * A FRIEND LINK (2026-10-31): the /play form with the match at the top and
 * the friend's name filled in when the member gave it. Public: the signed
 * token names the link. Opening it changes nothing; the sign-up waits for
 * his own WhatsApp code like any other, and only that books him in. A link
 * that was used, or whose game started or was called off, says so.
 * The card names the member's first name and the club, never a number.
 */
export default async function FriendLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const opened = await openFriendLink(token);
  if (!opened) return <FriendLinkClosed state="invalid" />;
  if (opened.state !== "open") return <FriendLinkClosed state={opened.state} />;
  const f = opened.facts;
  return (
    <PlaySignup
      source={{ campaignCode: null, referralCode: null }}
      // Friend links work while pool sign-ups are paused (D5): the club asked
      // for him. And he plays now, so no early-list note.
      paused={false}
      earlyList={false}
      friend={{
        token,
        member: opened.issuer,
        club: f.club,
        kickoffIso: f.kickoff.toISOString(),
        venue: f.venue,
        address: f.address,
        fee: f.fee,
        monthly: f.monthly,
        friendName: opened.friendName,
      }}
    />
  );
}
