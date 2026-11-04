/**
 * The admin path for the lifecycle field: how a human declares a club
 * dormant, and who is allowed to.
 *
 * `dormantAt` is DECLARED, never inferred (see src/lib/org-lifecycle.ts
 * for why). That makes this action the only way the value is ever set,
 * so its authorisation and its idempotence are the whole contract:
 *
 *  - as consequential as deletion in what it stops (no more fixtures),
 *    so it takes the same guard as `deleteOrganisation`: superadmin or
 *    OWNER, plus the org slug typed back;
 *  - reversible, so waking a club up needs no typed confirmation;
 *  - idempotent in the strong sense — re-marking an already-dormant org
 *    must NOT move the timestamp, because that date is the record of
 *    when the club actually went, and it is what a cleanup script and a
 *    future "when did we lose them?" question both read.
 *
 * auth / db / org / next-cache are mocked — no live DB.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const authMock = vi.fn();
const orgFindUnique = vi.fn();
const orgUpdate = vi.fn();
const membershipFindUnique = vi.fn();
const isSuperadminMock = vi.fn();
const botJobUpdateMany = vi.fn();
const order: string[] = [];

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/db", () => ({
  db: {
    organisation: {
      findUnique: (...a: unknown[]) => orgFindUnique(...a),
      update: (...a: unknown[]) => {
        order.push("wake");
        return orgUpdate(...a);
      },
    },
    membership: { findUnique: (...a: unknown[]) => membershipFindUnique(...a) },
    botJob: {
      updateMany: (...a: unknown[]) => {
        order.push("drop");
        return botJobUpdateMany(...a);
      },
    },
  },
}));
vi.mock("@/lib/org", () => ({
  isSuperadmin: (...a: unknown[]) => isSuperadminMock(...a),
  getCurrentOrgId: vi.fn(),
  setCurrentOrgId: vi.fn(),
  requireOrgAdmin: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const LIVE = { id: "org1", name: "Sutton Lads", slug: "sutton-lads", dormantAt: null };
const ALREADY = { ...LIVE, dormantAt: new Date("2026-06-18T12:00:00Z") };

async function actions() {
  return import("../org");
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "u1" } });
  orgFindUnique.mockResolvedValue(LIVE);
  orgUpdate.mockResolvedValue({});
  botJobUpdateMany.mockResolvedValue({ count: 0 });
  order.length = 0;
  isSuperadminMock.mockResolvedValue(false);
  membershipFindUnique.mockResolvedValue({ role: "OWNER", leftAt: null });
});

describe("markOrganisationDormant", () => {
  it("sets dormantAt for an OWNER who types the slug back", async () => {
    const { markOrganisationDormant } = await actions();
    await markOrganisationDormant("org1", "sutton-lads");

    expect(orgUpdate).toHaveBeenCalledTimes(1);
    const arg = orgUpdate.mock.calls[0][0] as { where: { id: string }; data: { dormantAt: Date } };
    expect(arg.where).toEqual({ id: "org1" });
    expect(arg.data.dormantAt).toBeInstanceOf(Date);
  });

  it("touches nothing else — not the bot flag, not a single Activity", async () => {
    // The mute switch and the per-fixture switch are different axes and
    // must stay where the operator left them.
    const { markOrganisationDormant } = await actions();
    await markOrganisationDormant("org1", "sutton-lads");
    const arg = orgUpdate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(Object.keys(arg.data)).toEqual(["dormantAt"]);
  });

  it("refuses a mistyped slug and writes nothing", async () => {
    const { markOrganisationDormant } = await actions();
    await expect(markOrganisationDormant("org1", "sutton-fc")).rejects.toThrow(/slug/i);
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it("refuses a plain ADMIN — this is an OWNER/superadmin act, like deletion", async () => {
    membershipFindUnique.mockResolvedValue({ role: "ADMIN", leftAt: null });
    const { markOrganisationDormant } = await actions();
    await expect(markOrganisationDormant("org1", "sutton-lads")).rejects.toThrow(/owner/i);
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it("allows a superadmin who is not a member at all", async () => {
    isSuperadminMock.mockResolvedValue(true);
    membershipFindUnique.mockResolvedValue(null);
    const { markOrganisationDormant } = await actions();
    await markOrganisationDormant("org1", "sutton-lads");
    expect(orgUpdate).toHaveBeenCalledTimes(1);
  });

  it("refuses an unauthenticated caller", async () => {
    authMock.mockResolvedValue(null);
    const { markOrganisationDormant } = await actions();
    await expect(markOrganisationDormant("org1", "sutton-lads")).rejects.toThrow(/authenticated/i);
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it("is a no-op on an already-dormant org — the original date is the record", async () => {
    orgFindUnique.mockResolvedValue(ALREADY);
    const { markOrganisationDormant } = await actions();
    await markOrganisationDormant("org1", "sutton-lads");
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it("refuses an org that does not exist", async () => {
    orgFindUnique.mockResolvedValue(null);
    const { markOrganisationDormant } = await actions();
    await expect(markOrganisationDormant("nope", "whatever")).rejects.toThrow(/not found/i);
  });
});

describe("reactivateOrganisation", () => {
  it("clears dormantAt — a club that comes back is the same club", async () => {
    orgFindUnique.mockResolvedValue(ALREADY);
    const { reactivateOrganisation } = await actions();
    await reactivateOrganisation("org1");
    expect(orgUpdate).toHaveBeenCalledWith({ where: { id: "org1" }, data: { dormantAt: null } });
  });

  it("needs no typed confirmation — waking a club up is not destructive", async () => {
    orgFindUnique.mockResolvedValue(ALREADY);
    const { reactivateOrganisation } = await actions();
    await expect(reactivateOrganisation("org1")).resolves.toBeUndefined();
  });

  it("still refuses a plain ADMIN", async () => {
    orgFindUnique.mockResolvedValue(ALREADY);
    membershipFindUnique.mockResolvedValue({ role: "ADMIN", leftAt: null });
    const { reactivateOrganisation } = await actions();
    await expect(reactivateOrganisation("org1")).rejects.toThrow(/owner/i);
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it("is a no-op on an org that was never dormant", async () => {
    const { reactivateOrganisation } = await actions();
    await reactivateOrganisation("org1");
    expect(orgUpdate).not.toHaveBeenCalled();
    expect(botJobUpdateMany).not.toHaveBeenCalled();
  });

  // The one rule (club summary B6, club-voice.ts): a dormant club gets
  // nothing, and what was queued for it while it slept is not sent when it
  // wakes (no catch-up, as a billing resume and a go-live). Dropped BEFORE
  // the wake, so no poll in between can send it.
  it("drops what was queued while it slept, before it wakes; a reminder set for later is kept", async () => {
    orgFindUnique.mockResolvedValue(ALREADY);
    botJobUpdateMany.mockResolvedValue({ count: 3 });
    const { reactivateOrganisation } = await actions();
    await reactivateOrganisation("org1");
    expect(order).toEqual(["drop", "wake"]);
    const where = botJobUpdateMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ orgId: "org1", sentAt: null });
    expect(where.OR).toEqual([{ sendAfter: null }, { sendAfter: { lte: expect.any(Date) } }]);
    expect(botJobUpdateMany.mock.calls[0][0].data).toEqual({ sentAt: expect.any(Date) });
  });
});
