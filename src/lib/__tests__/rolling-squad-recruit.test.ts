/**
 * Rolling squad (plan 1.7): a carried-over player has an Attendance row
 * on the match, so the recruit blast never invites him. Pinned here so
 * a later change to the "responded" rule cannot start DMing a squad that
 * is already in.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const membershipFindMany = vi.fn();
const matchFindFirst = vi.fn();
const matchFindMany = vi.fn();
const botJobCreate = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    match: {
      findFirst: (...a: unknown[]) => matchFindFirst(...a),
      // The club's next match (`next-match.ts`, club summary B4) reads the live
      // candidates: the one match `matchFindFirst` gives. Every other read is
      // the completed ones.
      findMany: async (...a: unknown[]) =>
        (a[0] as { where?: { status?: { in?: unknown } } })?.where?.status?.in
          ? [await matchFindFirst(...a)].filter(Boolean).map((m) => ({ status: "UPCOMING", ...m }))
          : matchFindMany(...a),
    },
    membership: { findMany: (...a: unknown[]) => membershipFindMany(...a) },
    sentNotification: { findUnique: async () => null, create: async () => ({}) },
    botJob: { create: (...a: unknown[]) => botJobCreate(...a) },
  },
}));
vi.mock("@/lib/magic-link", () => ({ signMagicLinkToken: () => "tok", MAGIC_LINK_TTL: { actionNudge: 1 } }));
vi.mock("@/lib/short-link", () => ({ buildShortMagicLinkUrl: async () => "https://s/x" }));
vi.mock("@/lib/london-time", async (orig) => ({
  ...(await orig<typeof import("@/lib/london-time")>()),
  formatLondon: () => "Fri 9 Oct, 20:30",
}));
vi.mock("@/lib/org-features", () => ({
  getOrgFeatures: async () => ({ attendance: true, bench: true, rollingSquad: true, language: "en" }),
}));

import { inviteRecentPlayers } from "@/lib/recruit";

beforeEach(() => {
  // The morning of the next match: the next-match rule reads the clock.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T09:00:00Z"));
  vi.clearAllMocks();
  // Two carried players (they have rows), 16 places still open.
  matchFindFirst.mockResolvedValue({
    id: "m-next",
    date: new Date("2026-10-09T19:30:00Z"),
    maxPlayers: 18,
    activity: { name: "Friday 9-a-side" },
    attendances: [
      { userId: "carried-1", status: "CONFIRMED" },
      { userId: "carried-2", status: "CONFIRMED" },
    ],
  });
  // The recent pool: both carried players, and one who has not answered.
  matchFindMany.mockResolvedValue([
    {
      attendances: [
        { userId: "carried-1", user: { id: "carried-1", name: "Hamzah", phoneNumber: "+447700900001" } },
        { userId: "carried-2", user: { id: "carried-2", name: "Raihan", phoneNumber: "+447700900002" } },
        { userId: "quiet", user: { id: "quiet", name: "Wasim", phoneNumber: "+447700900003" } },
      ],
    },
  ]);
  membershipFindMany.mockResolvedValue([]);
  botJobCreate.mockResolvedValue({ id: "job-1" });
});

describe("recruit skips carried-over players", () => {
  it("invites only the player with no row on the match", async () => {
    const res = await inviteRecentPlayers("org-fnf");
    expect(res.invited).toBe(1);
    const phones = botJobCreate.mock.calls.map((c) => (c[0] as { data: { phone: string } }).data.phone);
    expect(phones).toEqual(["447700900003"]);
  });
});
