/**
 * Recruit blast LOOKBACK window (owner request, 2026-08-31).
 *
 * The blast only considers players who appeared in the last N COMPLETED
 * matches. At N=3 the club's pool was 17 players, which after excluding
 * everyone already registered left only 9 invites. The owner asked for 5.
 *
 * Measured pool sizes for that org (12 completed matches, 73 active
 * members): 3 → 17, 5 → 22, 10 → 35, 12 → 39.
 *
 * The default is deliberately NOT raised beyond 5: the bot runs on an
 * unofficial WhatsApp client and a mass-DM risks the account being banned,
 * which takes the whole product down. The per-invocation override exists
 * so the window can be tuned without a deploy, and is CLAMPED for the
 * same reason.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const membershipFindMany = vi.fn();
const matchFindFirst = vi.fn();
const matchFindMany = vi.fn();
const sentFindUnique = vi.fn();
const sentCreate = vi.fn();
const botJobCreate = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    match: {
      findFirst: (...a: unknown[]) => matchFindFirst(...a),
      findMany: (...a: unknown[]) => matchFindMany(...a),
    },
    membership: { findMany: (...a: unknown[]) => membershipFindMany(...a) },
    sentNotification: {
      findUnique: (...a: unknown[]) => sentFindUnique(...a),
      create: (...a: unknown[]) => sentCreate(...a),
    },
    botJob: { create: (...a: unknown[]) => botJobCreate(...a) },
  },
}));
vi.mock("@/lib/magic-link", () => ({
  signMagicLinkToken: () => "tok",
  MAGIC_LINK_TTL: { actionNudge: 1 },
}));
vi.mock("@/lib/short-link", () => ({ buildShortMagicLinkUrl: async () => "https://s/x" }));
vi.mock("@/lib/london-time", () => ({ formatLondon: () => "Tue 1 Sep, 20:00" }));
vi.mock("@/lib/org-features", () => ({ getOrgFeatures: async () => ({ attendance: true }) }));

import {
  inviteRecentPlayers,
  LOOKBACK_MATCHES,
  RECRUIT_LOOKBACK_MAX,
  resolveLookbackMatches,
} from "@/lib/recruit";

const ORG = "org-1";

/** The `take` the recruit query used to pull recent completed matches. */
function takeUsed(): number {
  const call = matchFindMany.mock.calls.at(-1)?.[0] as { take: number };
  return call.take;
}

beforeEach(() => {
  vi.clearAllMocks();
  matchFindFirst.mockResolvedValue({
    id: "match-next",
    date: new Date("2026-09-01T19:00:00Z"),
    maxPlayers: 14,
    activity: { name: "Tuesday Footy" },
    attendances: [],
  });
  matchFindMany.mockResolvedValue([]);
  membershipFindMany.mockResolvedValue([]);
  sentFindUnique.mockResolvedValue(null);
  sentCreate.mockResolvedValue({});
  botJobCreate.mockResolvedValue({});
});

describe("LOOKBACK_MATCHES default", () => {
  it("is 5 (widened from 3 at the owner's request)", () => {
    expect(LOOKBACK_MATCHES).toBe(5);
  });

  it("is never raised beyond 5 by default — mass-DM ban risk", () => {
    expect(LOOKBACK_MATCHES).toBeLessThanOrEqual(5);
  });
});

describe("resolveLookbackMatches", () => {
  it("defaults to the constant when nothing is passed", () => {
    expect(resolveLookbackMatches()).toBe(LOOKBACK_MATCHES);
    expect(resolveLookbackMatches(undefined)).toBe(LOOKBACK_MATCHES);
  });

  it("honours an explicit override", () => {
    expect(resolveLookbackMatches(3)).toBe(3);
    expect(resolveLookbackMatches(10)).toBe(10);
  });

  it("floors a fractional override", () => {
    expect(resolveLookbackMatches(4.9)).toBe(4);
  });

  it("clamps a nonsense-low override to 1", () => {
    expect(resolveLookbackMatches(0)).toBe(1);
    expect(resolveLookbackMatches(-7)).toBe(1);
  });

  it("clamps a reckless override to the hard maximum", () => {
    expect(resolveLookbackMatches(500)).toBe(RECRUIT_LOOKBACK_MAX);
  });

  it("falls back to the default for a non-finite override", () => {
    expect(resolveLookbackMatches(Number.NaN)).toBe(LOOKBACK_MATCHES);
  });
});

describe("inviteRecentPlayers lookback wiring", () => {
  it("pulls 5 completed matches by default", async () => {
    await inviteRecentPlayers(ORG);
    expect(takeUsed()).toBe(5);
  });

  it("honours a per-invocation override so the window is tunable without a deploy", async () => {
    await inviteRecentPlayers(ORG, 10);
    expect(takeUsed()).toBe(10);
  });

  it("clamps a reckless per-invocation override", async () => {
    await inviteRecentPlayers(ORG, 9999);
    expect(takeUsed()).toBe(RECRUIT_LOOKBACK_MAX);
  });

  it("widening the window brings in players the narrower one missed", async () => {
    // Five completed matches; the 4th and 5th contain players nobody else
    // in the recent three played with.
    const completed = [
      { attendances: [{ userId: "a", user: { id: "a", name: "Alpha", phoneNumber: "+447700900001" } }] },
      { attendances: [{ userId: "b", user: { id: "b", name: "Bravo", phoneNumber: "+447700900002" } }] },
      { attendances: [{ userId: "c", user: { id: "c", name: "Charlie", phoneNumber: "+447700900003" } }] },
      { attendances: [{ userId: "d", user: { id: "d", name: "Delta", phoneNumber: "+447700900004" } }] },
      { attendances: [{ userId: "e", user: { id: "e", name: "Echo", phoneNumber: "+447700900005" } }] },
    ];
    matchFindMany.mockImplementation(async (args: { take: number }) =>
      completed.slice(0, args.take),
    );

    const narrow = await inviteRecentPlayers(ORG, 3);
    expect(narrow.invited).toBe(3);

    vi.clearAllMocks();
    matchFindFirst.mockResolvedValue({
      id: "match-next",
      date: new Date("2026-09-01T19:00:00Z"),
      maxPlayers: 14,
      activity: { name: "Tuesday Footy" },
      attendances: [],
    });
    matchFindMany.mockImplementation(async (args: { take: number }) =>
      completed.slice(0, args.take),
    );
    membershipFindMany.mockResolvedValue([]);
    sentFindUnique.mockResolvedValue(null);
    sentCreate.mockResolvedValue({});
    botJobCreate.mockResolvedValue({});

    const wide = await inviteRecentPlayers(ORG);
    expect(wide.invited).toBe(5);
    expect(wide.invitedNames).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
  });
});
