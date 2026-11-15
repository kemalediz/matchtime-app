/**
 * /play hands the code it read off the URL (`readSignupSource`) to
 * everything below it: the campaign game line, the funnel beacon and the
 * sign-up form. Nextdoor rewrites a typed `?src=nd` to `?nd` (2026-11-15),
 * which must reach all three as "nd".
 */
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const loadCampaignGame = vi.fn();
vi.mock("@/lib/pool/campaign-game-line-loader", () => ({ loadCampaignGame: (...a: unknown[]) => loadCampaignGame(...a) }));
vi.mock("@/lib/pool/growth", () => ({ poolInvitedByName: vi.fn(async () => null) }));
vi.mock("@/lib/pool/flags-page", () => ({ signupGoesOnEarlyListForPage: vi.fn(async () => false) }));
vi.mock("../play-signup", () => ({ PlaySignup: () => null }));
vi.mock("../funnel-beacon", () => ({ PoolFunnelBeacon: () => null }));

import PlayPage from "../page";

type Beacon = ReactElement<{ src: string | null; refCode: string | null; children: ReactElement<{ source: unknown; gameLine: string | null }> }>;

const render = async (q: Record<string, string>) => {
  loadCampaignGame.mockReset();
  loadCampaignGame.mockResolvedValue({ line: "Tuesday 7pm, 7-a-side", offer: "First game free for new players" });
  return (await PlayPage({ searchParams: Promise.resolve(q) })) as Beacon;
};

describe("/play passes one code to the game line, the beacon and the form", () => {
  it("Nextdoor's ?nd is src=nd everywhere", async () => {
    const page = await render({ nd: "" });
    expect(loadCampaignGame).toHaveBeenCalledWith("nd", "en");
    expect(page.props.src).toBe("nd");
    expect(page.props.children.props.source).toEqual({ campaignCode: "nd", referralCode: null });
    expect(page.props.children.props.gameLine).toBe("Tuesday 7pm, 7-a-side");
  });

  it("an explicit src still wins over a bare nd", async () => {
    const page = await render({ src: "fb1", nd: "" });
    expect(loadCampaignGame).toHaveBeenCalledWith("fb1", "en");
    expect(page.props.src).toBe("fb1");
  });
});
