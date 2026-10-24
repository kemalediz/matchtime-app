/**
 * H1 (review): a partner club's guest's contact details never reach the
 * club he guested for. D7: name and club only. A guest or past-guest
 * membership is never "shared" for contact fields, wherever a route or an
 * action derives "same club" from a membership row:
 *
 *   - GET /api/players/:id (the profile pages);
 *   - updatePlayerPhone (the asking club cannot set his number either);
 *   - GET /api/org/settings' money-collector candidates.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const getUserOrg = vi.fn();
const membershipFindFirst = vi.fn();
const membershipFindUnique = vi.fn();
const userFindUnique = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/org", () => ({
  getUserOrg: (...a: unknown[]) => getUserOrg(...a),
  isSuperadmin: vi.fn().mockResolvedValue(false),
  requireOrgAdmin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/admin-view", () => ({ seesAdminFields: vi.fn().mockResolvedValue(true) }));
vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// The account-safety gate has its own suite (player-account-takeover.test.ts);
// here an approved club, so the guest rule is what answers.
vi.mock("@/lib/player-account-guard", async () => ({
  // The real English table: the guest refusal is worded from it.
  playerEditContext: vi.fn(async () => ({ s: (await import("@/lib/i18n/strings.en")).en, refusal: null })),
  isClubOwnedUser: vi.fn(async () => true),
}));
vi.mock("@/lib/player-stats", () => ({ loadPlayerSeasonStats: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/db", () => ({
  db: {
    membership: {
      findFirst: (...a: unknown[]) => membershipFindFirst(...a),
      findUnique: (...a: unknown[]) => membershipFindUnique(...a),
    },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a), update: vi.fn() },
  },
}));

import { GET as getPlayer } from "@/app/api/players/[playerId]/route";

const call = (id: string) => getPlayer(new Request("http://x"), { params: Promise.resolve({ playerId: id }) }) as unknown as Promise<{ body: { player?: Record<string, unknown> }; status: number }>;

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "fnf-admin" } });
  getUserOrg.mockResolvedValue({ orgId: "fnf", role: "OWNER" });
  userFindUnique.mockResolvedValue({ id: "ali", name: "Ali K", email: "ali@x", image: null, phoneNumber: "+447700900111", activityPositions: [] });
});

describe("GET /api/players/:id and a partner club's guest", () => {
  it("the asking club's admin sees his name, never his phone or email (current guest)", async () => {
    membershipFindFirst.mockResolvedValue({ id: "m", guestFromOrgId: "sutton" });
    const r = await call("ali");
    expect(r.status).toBe(200);
    expect(r.body.player?.name).toBe("Ali K");
    expect(r.body.player).not.toHaveProperty("phoneNumber");
    expect(r.body.player).not.toHaveProperty("email");
  });

  it("nor a past guest's", async () => {
    membershipFindFirst.mockResolvedValue({ id: "m", guestFromOrgId: "sutton", leftAt: new Date() });
    const r = await call("ali");
    expect(r.body.player).not.toHaveProperty("phoneNumber");
  });

  it("nor a POOL guest's (no home club: guestFromOrgId null, guestMatchId set)", async () => {
    membershipFindFirst.mockResolvedValue({ id: "m", guestVia: "pool", guestFromOrgId: null, guestMatchId: "m-fnf", leftAt: null });
    const r = await call("ali");
    expect(r.status).toBe(200);
    expect(r.body.player?.name).toBe("Ali K");
    expect(r.body.player).not.toHaveProperty("phoneNumber");
    expect(r.body.player).not.toHaveProperty("email");
  });

  it("an ordinary member's contact details are shown to the club's admin, as before", async () => {
    membershipFindFirst.mockResolvedValue({ id: "m", guestFromOrgId: null, guestMatchId: null });
    const r = await call("ali");
    expect(r.body.player?.phoneNumber).toBe("+447700900111");
  });

  it("the player himself always sees his own", async () => {
    authMock.mockResolvedValue({ user: { id: "ali" } });
    const r = await call("ali");
    expect(r.body.player?.phoneNumber).toBe("+447700900111");
  });
});

describe("updatePlayerPhone and a guest", () => {
  it("the asking club cannot set a guest's number", async () => {
    authMock.mockResolvedValue({ user: { id: "fnf-admin" } });
    membershipFindUnique.mockResolvedValue({ userId: "ali", guestFromOrgId: "sutton" });
    const { updatePlayerPhone } = await import("@/app/actions/players");
    // Refused as data, not a throw (2026-10-18: Next redacts a thrown
    // Server-Action message, so the admin saw nothing useful).
    const r = await updatePlayerPhone("ali", "fnf", "+447700900999");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/guest/i);
  });

  it("nor a pool guest's", async () => {
    authMock.mockResolvedValue({ user: { id: "fnf-admin" } });
    membershipFindUnique.mockResolvedValue({ userId: "ali", guestFromOrgId: null, guestMatchId: "m-fnf" });
    const { updatePlayerPhone } = await import("@/app/actions/players");
    const r = await updatePlayerPhone("ali", "fnf", "+447700900999");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/guest/i);
  });
});

describe("the money-collector candidates", () => {
  it("never a guest", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "org", "settings", "route.ts"), "utf8");
    // Any guest, partner or pool: the shared fragment (guest-membership.ts).
    expect(src).toMatch(/where: \{ orgId: org\.id, leftAt: null, \.\.\.ORDINARY_MEMBER_WHERE, user: \{ phoneNumber: \{ not: null \} \} \}/);
  });
});
