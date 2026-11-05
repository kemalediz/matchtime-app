/**
 * NO DROP-OUT DEADLINE SUMMARY (Kemal, 2026-11-05).
 *
 * FNF's admin group got, at 20:30 on Thu 5 Nov 2026,
 *
 *   Drop-out deadline (Thu 5 Nov at 20:30) passed for *Football 9-a-side*,
 *   kick-off Fri 6 Nov at 20:30. Squad 18/18. Out this week: ...
 *
 * Kemal: "do we need this above? if drop out is removed, shouldn't we
 * remove this also". The drop-out reminder went in #547; this pins that
 * the summary after the deadline (D2) has gone the same way:
 *
 *   - nothing queues it: the due-posts route no longer calls a summary,
 *     and the module that built it is gone;
 *   - the first pick round after the deadline claims no
 *     `<matchId>:deadline-summary` key and leads as any other round does
 *     ("drop" when a player dropped, else "open-place").
 *
 * Drives the real sweep (`sweepOrganiserPicks`) with the db mocked. No
 * model, no network.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
  match: { findMany: vi.fn(), findUnique: vi.fn() },
  organiserPickRound: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({ id: "round1" })), updateMany: vi.fn() },
  membership: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  userAlias: { findMany: vi.fn(async () => []) },
  analyzedMessage: { findMany: vi.fn(async () => []) },
  attendanceEvent: { findMany: vi.fn(async () => []) },
  benchSlotOffer: { count: vi.fn(async () => 0) },
  adminSquadProposal: { count: vi.fn(async () => 0) },
  sentNotification: { create: vi.fn(async () => ({})) },
  playerActivityPosition: { findMany: vi.fn(async () => []) },
  rating: { findMany: vi.fn(async () => []) },
  attendance: { count: vi.fn(async () => 12) },
  botJob: { create: vi.fn(async () => ({})) },
}));
vi.mock("../db", () => ({ db: dbMock }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("../org-features", () => ({ getOrgFeatures: vi.fn(async () => ({ attendance: true })) }));
vi.mock("../partner-guest-standing", () => ({ loadGuestStandings: vi.fn(async () => new Map()) }));
const sendAdminNotice = vi.hoisted(() => vi.fn(async () => ({ channel: "admin-group", queued: 1 })));
vi.mock("../admin-channel", () => ({
  sendAdminNotice,
  loadAdminChannel: vi.fn(async () => ({ cfg: { mode: "admin-group", adminGroupId: "hq@g.us" }, admins: [] })),
}));
vi.mock("../organiser-pick-reader", () => ({ readPickReply: vi.fn() }));

import { sweepOrganiserPicks } from "../organiser-pick";

/** Fri 6 Nov 2026, 20:30 London (GMT): FNF's kick-off. */
const KICKOFF = new Date("2026-11-06T20:30:00.000Z");
/** Thu 5 Nov 2026, 20:35: just past FNF's Thursday 20:30 deadline. */
const AFTER_DEADLINE = new Date("2026-11-05T20:35:00.000Z");

const people = [
  { id: "u-hamza", name: "Hamza" },
  { id: "u-imz", name: "Imz" },
  { id: "u-raihan", name: "Raihan" },
];

function fnf() {
  dbMock.organisation.findUnique.mockResolvedValue({
    id: "fnf",
    name: "FNF",
    language: "en",
    benchPickMode: "organiser",
    benchPickFallback: "leave-empty",
    approvalStatus: "approved",
    dormantAt: null,
    billingStatus: "none",
    dropOutDeadlineDay: 4,
    dropOutDeadlineTime: "20:30",
  });
  dbMock.match.findMany.mockResolvedValue([
    {
      id: "m1",
      date: KICKOFF,
      createdAt: new Date("2026-10-30T10:00:00.000Z"),
      status: "UPCOMING",
      activityId: "act",
      isHistorical: false,
      activity: { orgId: "fnf", venue: "Goals", dayOfWeek: 5 },
    },
  ]);
  dbMock.match.findUnique.mockResolvedValue({
    id: "m1",
    date: KICKOFF,
    maxPlayers: 3,
    activityId: "act",
    activity: { name: "Football 9-a-side", venue: "Goals", orgId: "fnf", org: { language: "en" } },
    attendances: [
      { userId: "u-hamza", status: "DROPPED", position: 1, user: { name: "Hamza" } },
      { userId: "u-imz", status: "CONFIRMED", position: 2, user: { name: "Imz" } },
      { userId: "u-raihan", status: "BENCH", position: 3, user: { name: "Raihan" } },
    ],
  });
  dbMock.user.findMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
    people.filter((u) => args.where.id.in.includes(u.id)).map((u) => ({ ...u, phoneNumber: null, email: null })),
  );
  dbMock.membership.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    if (args.where.leftAt) return [];
    if (args.where.userId) return [];
    return people.map((u) => ({ user: { ...u, phoneNumber: null, email: null } }));
  });
}

const claimedKeys = () =>
  (dbMock.sentNotification.create.mock.calls as unknown as Array<[{ data: { key: string } }]>).map((c) => c[0].data.key);
const roundReason = () =>
  (dbMock.organiserPickRound.create.mock.calls as unknown as Array<[{ data: { reason: string } }]>)[0]?.[0].data.reason;
async function firstLine(): Promise<string> {
  expect(sendAdminNotice).toHaveBeenCalledTimes(1);
  const req = (sendAdminNotice.mock.calls[0] as unknown as [{ text: (link: string, audience: "dm" | "group") => string }])[0];
  return req.text("", "group").split("\n")[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  fnf();
});

describe("the first pick round after the drop-out deadline (Kemal, 2026-11-05)", () => {
  it("claims no deadline-summary key and leads with the open place when nobody dropped since", async () => {
    await sweepOrganiserPicks("fnf", AFTER_DEADLINE);
    expect(claimedKeys().some((k) => k.endsWith(":deadline-summary"))).toBe(false);
    expect(roundReason()).toBe("open-place");
    const lead = await firstLine();
    expect(lead).not.toMatch(/deadline/i);
    expect(lead).toContain("*Football 9-a-side*");
  });

  it("leads with the drop when a player dropped out before the deadline", async () => {
    dbMock.attendanceEvent.findMany.mockResolvedValueOnce([
      { userId: "u-hamza", note: null, actorKind: "player", sourceRef: null },
    ] as never);
    await sweepOrganiserPicks("fnf", AFTER_DEADLINE);
    expect(claimedKeys().some((k) => k.endsWith(":deadline-summary"))).toBe(false);
    expect(roundReason()).toBe("drop");
    expect(await firstLine()).toBe("*Hamza* dropped out of *Football 9-a-side* (Fri 6 Nov at 20:30). 2 places open, squad 1/3.");
  });
});

describe("nothing queues the summary any more", () => {
  const root = path.resolve(__dirname, "..", "..");
  it("the due-posts route calls no deadline summary", () => {
    const route = readFileSync(path.join(root, "app/api/whatsapp/due-posts/route.ts"), "utf8");
    expect(route).not.toMatch(/deadline-summary|DeadlineSummar/);
  });
  it("the module that built it is gone", () => {
    expect(existsSync(path.join(root, "lib/deadline-summary.ts"))).toBe(false);
  });
});
