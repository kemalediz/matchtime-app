import type { Metadata } from "next";
import { poolLinkPreviewCopy } from "@/lib/i18n/pool-link-preview";
import { isPoolSignupPaused } from "@/lib/pool/flags";
import { signupGoesOnEarlyListForPage } from "@/lib/pool/flags-page";
import { poolInvitedByName } from "@/lib/pool/growth";
import { poolPageCopy } from "@/lib/pool/page-copy";
import { readSignupSource } from "@/lib/pool/profile-fields";
import { poolPlaySharePath, poolShareMetadata } from "@/lib/pool/share-meta";
import { PlaySignup } from "./play-signup";
import { PoolVisitBeacon } from "./visit-beacon";

/**
 * /play: join the local player pool (slice L2). Public, no session data,
 * and never the MatchTime number: that comes back only in the sign-up
 * route's answer (src/app/api/play/signup/route.ts). The page is English
 * only (2026-11-02): no switch, no language field. `?src=` (a campaign,
 * `?c=` too) and `?ref=` (a friend's share code) are read here and sent
 * with the form.
 *
 * Its link preview (2026-11-03) is the player's, with og:url the link it
 * was opened with (`share-meta.ts`), and each visit is counted per code by
 * the beacon (`visit-beacon.tsx`).
 */
const en = poolPageCopy("en");

type Search = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ searchParams }: Search): Promise<Metadata> {
  const source = readSignupSource(await searchParams);
  return {
    title: en.title,
    description: en.description,
    ...poolShareMetadata(poolLinkPreviewCopy("en"), { url: poolPlaySharePath(source) }),
  };
}

export default async function PlayPage({ searchParams }: Search) {
  const source = readSignupSource(await searchParams);
  const invitedBy = await poolInvitedByName(source.referralCode).catch(() => null);
  return (
    <>
      <PoolVisitBeacon src={source.campaignCode} refCode={source.referralCode} />
      <PlaySignup source={source} paused={isPoolSignupPaused()} invitedBy={invitedBy} earlyList={await signupGoesOnEarlyListForPage()} />
    </>
  );
}
