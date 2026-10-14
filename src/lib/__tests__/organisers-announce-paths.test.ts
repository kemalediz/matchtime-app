/**
 * "Who announces the list and teams" = "The organisers" (2026-10-14) on the
 * paths OUTSIDE the scheduler that name who is in, in the players' group:
 *
 *   "Squad complete"       squad-announce.ts   -> the admin channel
 *   a place claimed        bench-confirmation  -> the admin channel
 *   an IN from the website out-of-band-announce-> the admin channel
 *   an organiser's pick    organiser-pick.ts   -> no group post (the DM to
 *                                                 the player stays)
 *
 * and, for each, the default ("matchtime") still posts in the group.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const matchFindUnique = vi.fn();
const sentCreate = vi.fn();
const botJobCreate = vi.fn();
const getOrgFeatures = vi.fn();
const sendAdminNotice = vi.fn(async () => ({ channel: "admin-group", queued: 1 }));

const attendanceCount = vi.fn(async () => 17);
const userFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    match: { findUnique: (...a: unknown[]) => matchFindUnique(...a) },
    sentNotification: { create: (...a: unknown[]) => sentCreate(...a) },
    botJob: { create: (...a: unknown[]) => botJobCreate(...a) },
    attendance: { count: (...a: unknown[]) => attendanceCount(...(a as [])) },
    user: { findMany: (...a: unknown[]) => userFindMany(...a) },
  },
}));
vi.mock("@/lib/org-features", () => ({
  getOrgFeatures: (...a: unknown[]) => getOrgFeatures(...a),
}));
vi.mock("@/lib/admin-channel", () => ({
  sendAdminNotice: (...a: unknown[]) => sendAdminNotice(...(a as [])),
}));

import { announceSquadFullIfJustFilled } from "@/lib/squad-announce";
import { announcePickToGroupAndPlayers } from "@/lib/organiser-pick";
import { buildOrganiserListUpdate } from "@/lib/organisers-list-copy";

const ORG = "org-fnf";
const NAMES = ["Ali", "Baki", "Can", "Deniz"];

function matchRow() {
  return {
    id: "m1",
    maxPlayers: 4,
    date: new Date("2026-10-16T19:30:00Z"),
    activity: { name: "FNF", orgId: ORG, org: { language: "en", squadMode: "weekly" } },
    attendances: [
      ...NAMES.map((name, i) => ({ status: "CONFIRMED", position: i + 1, user: { name } })),
      { status: "BENCH", position: 10, user: { name: "Emre" } },
    ],
    teamAssignments: [],
  };
}

beforeEach(() => {
  matchFindUnique.mockReset();
  sentCreate.mockReset();
  botJobCreate.mockReset();
  getOrgFeatures.mockReset();
  sendAdminNotice.mockClear();
  matchFindUnique.mockResolvedValue(matchRow());
  sentCreate.mockResolvedValue({});
});

describe("Squad complete", () => {
  it("organisers: the squad goes to the admin channel, nothing to the group", async () => {
    getOrgFeatures.mockResolvedValue({ bench: true, benchPickMode: "organiser", listAnnouncer: "organisers" });
    await announceSquadFullIfJustFilled("m1");
    expect(botJobCreate).not.toHaveBeenCalled();
    expect(sendAdminNotice).toHaveBeenCalledTimes(1);
    expect(sendAdminNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        text: buildOrganiserListUpdate({
          reason: "squad-complete",
          activityName: "FNF",
          whenLabel: "Fri 16 Oct at 20:30",
          confirmed: NAMES.map((name) => ({ name })),
          bench: [{ name: "Emre" }],
          maxPlayers: 4,
          lang: "en",
        }),
      }),
    );
    // The claim is still taken, so it is told once per fill.
    expect(sentCreate).toHaveBeenCalledTimes(1);
  });

  it("matchtime (default): the group post, no admin notice", async () => {
    getOrgFeatures.mockResolvedValue({ bench: false });
    await announceSquadFullIfJustFilled("m1");
    expect(sendAdminNotice).not.toHaveBeenCalled();
    expect(botJobCreate).toHaveBeenCalledTimes(1);
    expect(botJobCreate.mock.calls[0][0].data.kind).toBe("group");
  });
});

describe("an organiser's pick", () => {
  function pickMatch(listAnnouncer: string) {
    return {
      id: "m1",
      maxPlayers: 18,
      date: new Date("2026-10-16T19:30:00Z"),
      teamLabels: [],
      activity: {
        venue: "Powerleague",
        sport: { teamLabels: [] },
        org: { id: ORG, teamLabels: [], language: "en", listAnnouncer },
      },
    };
  }
  const result = {
    applied: [{ userId: "u-emre", name: "Emre", team: null, replacedName: null }],
    alreadyIn: [],
    notOnWaitingList: [],
    noPlaceFor: [],
    confirmedAfter: 17,
    maxPlayers: 18,
    filled: false,
  };

  beforeEach(() => {
    userFindMany.mockResolvedValue([
      { id: "u-emre", phoneNumber: "+447700900123", memberships: [{ subMatchInviteDm: true }] },
    ]);
  });

  it("organisers: no group post naming the player; the player's own DM still goes", async () => {
    matchFindUnique.mockResolvedValue(pickMatch("organisers"));
    await announcePickToGroupAndPlayers("m1", result as never);
    const kinds = botJobCreate.mock.calls.map((c) => c[0].data.kind);
    expect(kinds).toEqual(["dm"]);
  });

  it("matchtime (default): the group post and the DM, as before", async () => {
    matchFindUnique.mockResolvedValue(pickMatch("matchtime"));
    await announcePickToGroupAndPlayers("m1", result as never);
    const kinds = botJobCreate.mock.calls.map((c) => c[0].data.kind);
    expect(kinds).toEqual(["group", "dm"]);
  });
});
