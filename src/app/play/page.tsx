import type { Metadata } from "next";
import { poolLinkPreviewCopy } from "@/lib/i18n/pool-link-preview";
import { signupGoesOnEarlyList } from "@/lib/pool/flags";
import { poolSignupPausedForPage } from "@/lib/pool/flags-page";
import { poolEnvForRequest } from "@/lib/pool/switch-env";
import { poolInvitedByName } from "@/lib/pool/growth";
import { loadCampaignGame } from "@/lib/pool/campaign-game-line-loader";
import { poolPageCopy } from "@/lib/pool/page-copy";
import { readSignupSource } from "@/lib/pool/profile-fields";
import { poolPlaySharePath, poolShareMetadata } from "@/lib/pool/share-meta";
import { PlaySignup } from "./play-signup";
import { PoolFunnelBeacon } from "./funnel-beacon";

/**
 * /play: join the local player pool (slice L2). Public, no session data,
 * and never the MatchTime number: that comes back only in the sign-up
 * route's answer (src/app/api/play/signup/route.ts). The page is English
 * only (2026-11-02): no switch, no language field. `?src=` (a campaign,
 * `?c=` too; a bare `?nd` is `src=nd`, as Nextdoor rewrites the link) and
 * `?ref=` (a friend's share code) are read here (`readSignupSource`) and
 * sent with the form.
 *
 * Its link preview (2026-11-03) is the player's, with og:url the link it
 * was opened with (`share-meta.ts`). Each visit, and the first touch of the
 * form, is counted per code by the beacon wrapped round the form
 * (`funnel-beacon.tsx`).
 *
 * A Facebook or Nextdoor link (`?src=fb`, `fb1`, `fb2`, `nd`) names the
 * game its post sells at the top, while that game has a place, with the
 * club's first-game-free offer under it when the club has one
 * (`campaign-game-line.ts`). Not while sign-ups are paused: then the game
 * is not loaded at all. Nor while no ask could go out for the club (the
 * pool switch, 2026-11-16): the switch is resolved once per render
 * (`poolEnvForRequest`, its test cookie honoured only under MT_TEST_MODE=1)
 * and decides both the game line and the early-list note.
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
  const [paused, poolEnv] = await Promise.all([poolSignupPausedForPage(), poolEnvForRequest()]);
  // Paused: no form, so no game to name; the game is not even loaded.
  const [invitedBy, game] = await Promise.all([
    poolInvitedByName(source.referralCode).catch(() => null),
    paused ? null : loadCampaignGame(source.campaignCode, "en", { env: poolEnv }).catch(() => null),
  ]);
  return (
    <PoolFunnelBeacon src={source.campaignCode} refCode={source.referralCode}>
      <PlaySignup
        source={source}
        paused={paused}
        invitedBy={invitedBy}
        gameLine={game?.line ?? null}
        gameOffer={game?.offer ?? null}
        earlyList={signupGoesOnEarlyList(poolEnv)}
      />
    </PoolFunnelBeacon>
  );
}
