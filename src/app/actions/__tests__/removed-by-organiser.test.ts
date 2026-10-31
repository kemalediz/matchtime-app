/**
 * WHO ENDED A MEMBERSHIP (Kemal, 2026-10-31). The players page Remove is an
 * organiser's removal, so it stamps `removedByOrganiserAt` beside `leftAt`;
 * the club's guest doors (pool offers, a friend's link) then stay shut for
 * him. The organiser's own action always wins: adding him back to the club,
 * or onto a match, clears the stamp.
 *
 * auth / db / org / next-cache are mocked. No live DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const membershipUpdate = vi.fn(async (..._a: unknown[]) => ({}));
const membershipFindUnique = vi.fn();
const userFindUnique = vi.fn();
const takeOff = vi.fn(async (..._a: unknown[]) => []);

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: vi.fn(async () => undefined) }));
vi.mock("@/lib/player-account-guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/player-account-guard")>()),
  playerEditContext: vi.fn(async () => ({ s: new Proxy({}, { get: (_t, k) => String(k) }), refusal: null })),
  isClubOwnedUser: vi.fn(async () => false),
}));
vi.mock("@/lib/resolve-player", () => ({ findExistingOrgMember: vi.fn(async () => null) }));
vi.mock("@/lib/merge-players-core", () => ({ mergePlayersCore: vi.fn() }));
vi.mock("@/lib/attendance-events", () => ({ recordAttendanceEvent: vi.fn() }));
vi.mock("@/lib/member-removal", () => ({ takeRemovedMemberOffUpcomingMatches: (...a: unknown[]) => takeOff(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    membership: {
      update: (...a: unknown[]) => membershipUpdate(...a),
      findUnique: (...a: unknown[]) => membershipFindUnique(...a),
      create: vi.fn(async () => ({})),
    },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a), update: vi.fn(async () => ({})) },
  },
}));

import { createPlayer, removeProvisionalPlayer } from "@/app/actions/players";

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "admin1" } });
});

const dataOf = (call: unknown[]) => (call[0] as { data: Record<string, unknown> }).data;

describe("the players page Remove", () => {
  it("stamps who ended it: an organiser, at the same instant as leftAt", async () => {
    await expect(removeProvisionalPlayer("p1", "club")).resolves.toEqual({ ok: true });
    const data = dataOf(membershipUpdate.mock.calls[0]);
    expect(data.leftAt).toBeInstanceOf(Date);
    expect(data.removedByOrganiserAt).toBeInstanceOf(Date);
    expect((data.removedByOrganiserAt as Date).getTime()).toBe((data.leftAt as Date).getTime());
  });
});

describe("the organiser adds him back to the club", () => {
  it("by his number: the membership is live again and the stamp is cleared", async () => {
    userFindUnique.mockResolvedValue({ id: "p1", name: "Glazers" });
    membershipFindUnique.mockResolvedValue({ id: "mem1", leftAt: new Date(), guestMatchId: null });
    const r = await createPlayer("club", "Glazers", "+447700900123");
    expect(r).toMatchObject({ ok: true, rejoined: true });
    expect(dataOf(membershipUpdate.mock.calls[0])).toEqual({ leftAt: null, removedByOrganiserAt: null });
  });

  it("by his name: the same", async () => {
    const { findExistingOrgMember } = await import("@/lib/resolve-player");
    vi.mocked(findExistingOrgMember).mockResolvedValueOnce({ userId: "p1" } as never);
    membershipFindUnique.mockResolvedValue({ id: "mem1", leftAt: new Date() });
    const r = await createPlayer("club", "Glazers");
    expect(r).toMatchObject({ ok: true, rejoined: true });
    expect(dataOf(membershipUpdate.mock.calls[0])).toEqual({ leftAt: null, removedByOrganiserAt: null });
  });
});
