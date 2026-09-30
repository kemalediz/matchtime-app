/**
 * The match page's "Carry over last squad" button (2026-09-30, plan
 * 1.9): admin only, rolling-squad clubs only, and it goes through the
 * same `seedRollingSquad` as the 08:00 cron, recorded as the admin.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const authMock = vi.fn();
const requireOrgAdmin = vi.fn();
const matchFindUnique = vi.fn();
const findCarryOverSource = vi.fn();
const seedRollingSquad = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: (...a: unknown[]) => requireOrgAdmin(...a) }));
vi.mock("@/lib/email", () => ({ sendRatingEmails: vi.fn() }));
vi.mock("@/lib/elo", () => ({ computeEloDeltas: vi.fn(() => []) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { match: { findUnique: (...a: unknown[]) => matchFindUnique(...a) } } }));
vi.mock("@/lib/rolling-squad", () => ({
  findCarryOverSource: (...a: unknown[]) => findCarryOverSource(...a),
  seedRollingSquad: (...a: unknown[]) => seedRollingSquad(...a),
}));

const { carryOverLastSquad } = await import("../matches");

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "u-hamzah" } });
  requireOrgAdmin.mockResolvedValue(undefined);
  matchFindUnique.mockResolvedValue({ id: "m-next", activity: { orgId: "org-fnf", org: { rollingSquadEnabled: true } } });
  findCarryOverSource.mockResolvedValue({ id: "m-last", date: new Date("2026-10-02T19:30:00Z") });
  seedRollingSquad.mockResolvedValue({ seeded: true, carried: 16, overflow: 0 });
});

describe("carryOverLastSquad", () => {
  it("seeds from the last played match, as the admin", async () => {
    const res = await carryOverLastSquad("m-next");
    expect(requireOrgAdmin).toHaveBeenCalledWith("u-hamzah", "org-fnf");
    expect(seedRollingSquad).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "m-next", sourceId: "m-last", actor: { kind: "admin", userId: "u-hamzah" } }),
    );
    expect(res).toEqual({ carried: 16 });
  });

  it("refuses a non-admin before touching anything", async () => {
    requireOrgAdmin.mockRejectedValue(new Error("Admin access required"));
    await expect(carryOverLastSquad("m-next")).rejects.toThrow("Admin access required");
    expect(seedRollingSquad).not.toHaveBeenCalled();
  });

  it("refuses a club without the rolling squad", async () => {
    matchFindUnique.mockResolvedValue({ id: "m-next", activity: { orgId: "org-fnf", org: { rollingSquadEnabled: false } } });
    await expect(carryOverLastSquad("m-next")).rejects.toThrow();
    expect(seedRollingSquad).not.toHaveBeenCalled();
  });

  it("nothing to carry: carries nobody", async () => {
    findCarryOverSource.mockResolvedValue(null);
    expect(await carryOverLastSquad("m-next")).toEqual({ carried: 0 });
    expect(seedRollingSquad).not.toHaveBeenCalled();
  });
});
