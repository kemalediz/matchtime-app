/**
 * Sending partner requests from "Find clubs near you" (P3): the server
 * action. A public endpoint: the club is the caller's active club, owners
 * and admins only. It returns the shape the P2 search page (#374) reads,
 * with each refusal named by the codes that page has copy for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/auth", () => authMock);
const orgMock = vi.hoisted(() => ({ getUserOrg: vi.fn(), isOrgAdmin: vi.fn() }));
vi.mock("@/lib/org", () => orgMock);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const dbMock = vi.hoisted(() => ({ membership: { findUnique: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const writer = vi.hoisted(() => ({ requestPartnerships: vi.fn() }));
vi.mock("@/lib/club-partnership", () => writer);

import { sendPartnerRequestsAction } from "../partner-requests";

const refused = (partnerOrgId: string, refusal: string) => ({ partnerOrgId, partnerName: partnerOrgId, outcome: "refused", refusal });

beforeEach(() => {
  vi.clearAllMocks();
  authMock.auth.mockResolvedValue({ user: { id: "u1" } });
  orgMock.getUserOrg.mockResolvedValue({ orgId: "fnf", role: "ADMIN" });
  orgMock.isOrgAdmin.mockResolvedValue(true);
  dbMock.membership.findUnique.mockResolvedValue({ role: "OWNER", leftAt: null });
  writer.requestPartnerships.mockResolvedValue({
    results: [
      { partnerOrgId: "a", partnerName: "A", outcome: "sent" },
      { partnerOrgId: "auto", partnerName: "Auto", outcome: "active" },
      refused("b", "daily-cap"),
    ],
    sent: 2,
    capped: true,
  });
});

describe("sendPartnerRequestsAction", () => {
  it("sends for the caller's club, as its owner; each club's outcome and the nearest-20 flag come back", async () => {
    const r = await sendPartnerRequestsAction({ partnerOrgIds: ["a", "auto", "b"] });
    expect(writer.requestPartnerships).toHaveBeenCalledWith({ askerOrgId: "fnf", userId: "u1", role: "OWNER", partnerOrgIds: ["a", "auto", "b"] });
    expect(r).toEqual({
      ok: true,
      results: [
        { orgId: "a", outcome: "sent" },
        // Accepted at once by a club that accepts automatically: it went.
        { orgId: "auto", outcome: "sent" },
        { orgId: "b", outcome: "refused", reason: "daily-cap" },
      ],
      capped: true,
    });
  });

  it("the refusal codes are the search page's", async () => {
    writer.requestPartnerships.mockResolvedValue({
      results: [
        refused("1", "daily-cap"),
        refused("2", "pending-cap"),
        refused("3", "cooldown"),
        refused("4", "blocked"),
        refused("5", "already-paired"),
        refused("6", "already-pending"),
        refused("7", "not-listed"),
        refused("8", "hidden"),
      ],
      sent: 0,
      capped: true,
    });
    const r = await sendPartnerRequestsAction({ partnerOrgIds: ["1", "2", "3", "4", "5", "6", "7", "8"] });
    expect(r.results!.map((x) => x.reason)).toEqual(["daily-cap", "pending-cap", "cooldown", "blocked", "already-paired", "pending", "not-discoverable", "hidden"]);
  });

  it("an admin sends as ADMIN", async () => {
    dbMock.membership.findUnique.mockResolvedValue({ role: "ADMIN", leftAt: null });
    await sendPartnerRequestsAction({ partnerOrgIds: ["a"] });
    expect(writer.requestPartnerships).toHaveBeenCalledWith(expect.objectContaining({ role: "ADMIN" }));
  });

  it("a player, nobody signed in, or no club: refused before anything is written", async () => {
    orgMock.isOrgAdmin.mockResolvedValue(false);
    expect(await sendPartnerRequestsAction({ partnerOrgIds: ["a"] })).toEqual({ ok: false, error: "not-admin" });
    orgMock.getUserOrg.mockResolvedValue(null);
    expect(await sendPartnerRequestsAction({ partnerOrgIds: ["a"] })).toEqual({ ok: false, error: "no-club" });
    authMock.auth.mockResolvedValue(null);
    expect(await sendPartnerRequestsAction({ partnerOrgIds: ["a"] })).toEqual({ ok: false, error: "not-signed-in" });
    expect(writer.requestPartnerships).not.toHaveBeenCalled();
  });

  it("anything that is not a list of ids sends nothing it was not given", async () => {
    await sendPartnerRequestsAction({ partnerOrgIds: ["a", 7, null] as never });
    expect(writer.requestPartnerships).toHaveBeenCalledWith(expect.objectContaining({ partnerOrgIds: ["a"] }));
    await sendPartnerRequestsAction({} as never);
    expect(writer.requestPartnerships).toHaveBeenLastCalledWith(expect.objectContaining({ partnerOrgIds: [] }));
  });
});
