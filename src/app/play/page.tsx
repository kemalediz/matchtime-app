import type { Metadata } from "next";
import { isPoolSignupPaused } from "@/lib/pool/flags";
import { signupGoesOnEarlyListForPage } from "@/lib/pool/flags-page";
import { poolInvitedByName } from "@/lib/pool/growth";
import { poolPageCopy } from "@/lib/pool/page-copy";
import { readSignupSource } from "@/lib/pool/profile-fields";
import { PlaySignup } from "./play-signup";

/**
 * /play: join the local player pool (slice L2). Public, no session data,
 * and never the MatchTime number: that comes back only in the sign-up
 * route's answer (src/app/api/play/signup/route.ts). The page follows the
 * visitor's browser language and has a switch. `?c=` (a campaign) and
 * `?ref=` (a friend's share code) are read here and sent with the form.
 */
const en = poolPageCopy("en");

export const metadata: Metadata = {
  title: en.title,
  description: en.description,
};

export default async function PlayPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const source = readSignupSource(await searchParams);
  const invitedBy = await poolInvitedByName(source.referralCode).catch(() => null);
  return <PlaySignup source={source} paused={isPoolSignupPaused()} invitedBy={invitedBy} earlyList={await signupGoesOnEarlyListForPage()} />;
}
