/**
 * /play hands the code it read off the URL (`readSignupSource`) to
 * everything below it: the campaign game line, the funnel beacon and the
 * sign-up form. Nextdoor rewrites a typed `?src=nd` to `?nd` (2026-11-15),
 * which must reach all three as "nd".
 *
 * The pool switch is resolved ONCE per render (`poolEnvForRequest`) and
 * handed both to the game line (which names a game only while an ask
 * could go out for the club) and to the early-list note (2026-11-16).
 */
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const loadCampaignGame = vi.fn();
vi.mock("@/lib/pool/campaign-game-line-loader", () => ({ loadCampaignGame: (...a: unknown[]) => loadCampaignGame(...a) }));
vi.mock("@/lib/pool/growth", () => ({ poolInvitedByName: vi.fn(async () => null) }));
const paused = vi.hoisted(() => ({ on: false, poolOpen: true }));
vi.mock("@/lib/pool/flags-page", () => ({
  poolSignupPausedForPage: vi.fn(async () => paused.on),
}));
vi.mock("@/lib/pool/switch-env", async () => {
  const { poolSwitchEnv } = await import("@/lib/pool/flags");
  return { poolEnvForRequest: vi.fn(async () => poolSwitchEnv(paused.poolOpen)) };
});
vi.mock("../play-signup", () => ({ PlaySignup: () => null }));
vi.mock("../funnel-beacon", () => ({ PoolFunnelBeacon: () => null }));

import PlayPage from "../page";

type Beacon = ReactElement<{
  src: string | null;
  refCode: string | null;
  children: ReactElement<{ source: unknown; paused: boolean; gameLine: string | null; gameOffer: string | null; earlyList: boolean }>;
}>;

const render = async (q: Record<string, string>, o: { paused?: boolean; poolOpen?: boolean } = {}) => {
  paused.on = o.paused ?? false;
  paused.poolOpen = o.poolOpen ?? true;
  loadCampaignGame.mockReset();
  loadCampaignGame.mockResolvedValue({ line: "Tuesday 7pm, 7-a-side", offer: "First game free for new players" });
  return (await PlayPage({ searchParams: Promise.resolve(q) })) as Beacon;
};

describe("/play passes one code to the game line, the beacon and the form", () => {
  it("Nextdoor's ?nd is src=nd everywhere", async () => {
    const page = await render({ nd: "" });
    expect(loadCampaignGame).toHaveBeenCalledWith("nd", "en", { env: expect.objectContaining({ MT_POOL_OPEN: "1" }) });
    expect(page.props.src).toBe("nd");
    expect(page.props.children.props.source).toEqual({ campaignCode: "nd", referralCode: null });
    expect(page.props.children.props.gameLine).toBe("Tuesday 7pm, 7-a-side");
  });

  it("an explicit src still wins over a bare nd", async () => {
    const page = await render({ src: "fb1", nd: "" });
    expect(loadCampaignGame).toHaveBeenCalledWith("fb1", "en", { env: expect.objectContaining({ MT_POOL_OPEN: "1" }) });
    expect(page.props.src).toBe("fb1");
  });
});

describe("/play while sign-ups are paused (review, 2026-11-15)", () => {
  it("does not load the game at all, and the form gets no line or offer", async () => {
    const page = await render({ src: "fb1" }, { paused: true });
    expect(loadCampaignGame).not.toHaveBeenCalled();
    expect(page.props.children.props.paused).toBe(true);
    expect(page.props.children.props.gameLine).toBeNull();
    expect(page.props.children.props.gameOffer).toBeNull();
  });

  it("open: the game is loaded as before", async () => {
    const page = await render({ src: "fb1" });
    expect(loadCampaignGame).toHaveBeenCalledWith("fb1", "en", { env: expect.objectContaining({ MT_POOL_OPEN: "1" }) });
    expect(page.props.children.props.paused).toBe(false);
    expect(page.props.children.props.gameOffer).toBe("First game free for new players");
  });
});

describe("/play resolves the pool switch once, for the game line and the early-list note (2026-11-16)", () => {
  it("open: the loader gets the open switch, and no early-list note", async () => {
    const page = await render({ src: "fb1" });
    expect(loadCampaignGame).toHaveBeenCalledWith("fb1", "en", { env: expect.objectContaining({ MT_POOL_OPEN: "1" }) });
    expect(page.props.children.props.earlyList).toBe(false);
  });

  it("closed: the loader gets the closed switch, and the early-list note shows", async () => {
    const page = await render({ src: "fb1" }, { poolOpen: false });
    expect(loadCampaignGame).toHaveBeenCalledWith("fb1", "en", { env: expect.objectContaining({ MT_POOL_OPEN: "0" }) });
    expect(page.props.children.props.earlyList).toBe(true);
  });
});
