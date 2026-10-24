/**
 * The owner's campaign-code actions (pool slice G1): a server action is a
 * public endpoint, so the superadmin check is here, not only on the page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/auth", () => authMock);
const orgMock = vi.hoisted(() => ({ isSuperadmin: vi.fn() }));
vi.mock("@/lib/org", () => orgMock);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const store = vi.hoisted(() => ({ createPoolCampaign: vi.fn(), setPoolCampaignActive: vi.fn() }));
vi.mock("@/lib/pool/campaigns", () => store);

import { createPoolCampaignAction, setPoolCampaignActiveAction } from "../pool-campaigns";

const INPUT = { code: "li-kemal", source: "linkedin", label: "post" };

beforeEach(() => {
  vi.clearAllMocks();
  authMock.auth.mockResolvedValue({ user: { id: "u1" } });
  orgMock.isSuperadmin.mockResolvedValue(true);
  store.createPoolCampaign.mockResolvedValue({ ok: true, code: "li-kemal" });
  store.setPoolCampaignActive.mockResolvedValue(true);
});

describe("pool campaign actions", () => {
  it("the owner creates and switches codes", async () => {
    expect(await createPoolCampaignAction(INPUT)).toEqual({ ok: true, code: "li-kemal" });
    expect(store.createPoolCampaign).toHaveBeenCalledWith(INPUT);
    expect(await setPoolCampaignActiveAction("li-kemal", false)).toEqual({ ok: true });
    expect(store.setPoolCampaignActive).toHaveBeenCalledWith("li-kemal", false);
  });

  it("anybody else is refused and nothing is written", async () => {
    orgMock.isSuperadmin.mockResolvedValue(false);
    expect(await createPoolCampaignAction(INPUT)).toEqual({ ok: false, reason: "forbidden" });
    expect(await setPoolCampaignActiveAction("li-kemal", false)).toEqual({ ok: false });
    authMock.auth.mockResolvedValue(null);
    expect(await createPoolCampaignAction(INPUT)).toEqual({ ok: false, reason: "forbidden" });
    expect(store.createPoolCampaign).not.toHaveBeenCalled();
    expect(store.setPoolCampaignActive).not.toHaveBeenCalled();
  });

  it("refuses a malformed switch call", async () => {
    expect(await setPoolCampaignActiveAction(42, "yes")).toEqual({ ok: false });
    expect(store.setPoolCampaignActive).not.toHaveBeenCalled();
  });
});
