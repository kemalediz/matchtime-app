/**
 * `createActivity` and `updateActivity`: no venue-location column is ever
 * accepted from the request (review of PR #241, fix 1).
 *
 * A server action is called over the network with whatever the caller
 * sends. Had `venueId`, `venueConfidence`, `venueMatchSource`,
 * `venueLookupStatus`, `venueResolvedAt`, `venueConfirmedAt` or
 * `venueConfirmedById` been writable, a club admin could have dressed
 * their own pin up as a confident match. These tests send every one of
 * them, plus the columns of the earlier design, and read what reached
 * Prisma.
 *
 * Everything around the actions is mocked: no database, no network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { activityUpdateData, activityVenueReset } from "../activity-update";

const m = vi.hoisted(() => ({
  writes: [] as Array<{ op: string; data: Record<string, unknown> }>,
  current: {
    id: "act-a",
    orgId: "org-a",
    venue: "Powerleague Shoreditch",
    venueId: "venue-old",
    feeSplitTotal: false,
  } as Record<string, unknown>,
  schedule: vi.fn(async () => undefined),
  schedulePick: vi.fn(async () => undefined),
  dropPin: vi.fn(async () => undefined),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "owner-a" } }) }));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: async () => undefined }));
vi.mock("@/lib/venue-location", () => ({ dropOrphanPin: m.dropPin }));
vi.mock("@/lib/venue-location-schedule", () => ({ scheduleVenueResolve: m.schedule, scheduleVenuePickResolve: m.schedulePick }));
vi.mock("@/lib/db", () => ({
  db: {
    sport: { findFirst: async () => ({ id: "sport-a", preset: "football-7aside", name: "Football 7-a-side", playersPerTeam: 7 }) },
    activity: {
      findUnique: async () => m.current,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        m.writes.push({ op: "create", data });
        return { id: "act-new" };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        m.writes.push({ op: "update", data });
        return {};
      },
    },
  },
}));

import { createActivity, updateActivity } from "@/app/actions/activities";

/** Everything a hostile client might add, each with a value Prisma would take. */
const SNEAKY = {
  venueId: "attacker-pin",
  venueConfidence: "high",
  venueMatchSource: "text",
  venueLookupStatus: "found",
  venueResolvedAt: new Date("2026-01-01"),
  venueConfirmedAt: new Date("2026-01-01"),
  venueConfirmedById: "someone-else",
  venueQueryKey: "GB|powerleague shoreditch",
  venueRef: { connect: { id: "attacker-pin" } },
};
const COLUMNS = Object.keys(SNEAKY);

beforeEach(() => {
  m.writes.length = 0;
  m.schedule.mockClear();
  m.schedulePick.mockClear();
  m.dropPin.mockClear();
});

describe("the whitelist (activity-update.ts)", () => {
  it.each(COLUMNS)("%s sent by a client is dropped", (column) => {
    const sent = { name: "Tuesday 7s", [column]: (SNEAKY as Record<string, unknown>)[column] };
    expect(activityUpdateData(sent, { feeSplitTotal: false })).toEqual({ ok: true, data: { name: "Tuesday 7s" } });
  });

  it("new venue words reset every venue-location column; the same words in another case or punctuation do not", () => {
    const current = { venue: "Powerleague Shoreditch" };
    expect(activityVenueReset({ venue: "Goals North Cheam" }, current)).toEqual({
      venueId: null,
      venueConfidence: null,
      venueMatchSource: null,
      venueLookupStatus: null,
      venueResolvedAt: null,
      venueConfirmedAt: null,
      venueConfirmedById: null,
    });
    expect(activityVenueReset({ venue: "powerleague,  SHOREDITCH!" }, current)).toBeNull();
    expect(activityVenueReset({ time: "21:00" } as { venue?: unknown }, current)).toBeNull();
    expect(activityVenueReset({}, current)).toBeNull();
    // Two names in another alphabet are two venues.
    expect(activityVenueReset({ venue: "Стадион Спартак" }, { venue: "Стадион Динамо" })).not.toBeNull();
  });
});

describe("updateActivity", () => {
  it("every venue-location column a client adds is ignored: only the named field is written", async () => {
    await updateActivity("act-a", { time: "21:00", ...SNEAKY } as never);
    expect(m.writes).toEqual([{ op: "update", data: { time: "21:00" } }]);
  });

  it.each(COLUMNS)("%s alone changes nothing", async (column) => {
    await updateActivity("act-a", { [column]: (SNEAKY as Record<string, unknown>)[column] } as never);
    expect(m.writes).toEqual([{ op: "update", data: {} }]);
    expect(m.schedule).not.toHaveBeenCalled();
  });

  it("new venue words: the columns are RESET to null by the server, whatever the client sent for them", async () => {
    await updateActivity("act-a", { venue: "Goals North Cheam", ...SNEAKY } as never);
    expect(m.writes).toEqual([
      {
        op: "update",
        data: {
          venue: "Goals North Cheam",
          venueId: null,
          venueConfidence: null,
          venueMatchSource: null,
          venueLookupStatus: null,
          venueResolvedAt: null,
          venueConfirmedAt: null,
          venueConfirmedById: null,
        },
      },
    ]);
    expect(m.schedule).toHaveBeenCalledWith("act-a");
    expect(m.dropPin).toHaveBeenCalledWith("venue-old");
  });

  it("an edit of the time only schedules no lookup and touches no venue column", async () => {
    await updateActivity("act-a", { time: "21:00" });
    expect(m.writes).toEqual([{ op: "update", data: { time: "21:00" } }]);
    expect(m.schedule).not.toHaveBeenCalled();
    expect(m.dropPin).not.toHaveBeenCalled();
  });

  it("a punctuation-only change of the venue keeps the place and schedules nothing", async () => {
    await updateActivity("act-a", { venue: "powerleague  shoreditch." });
    expect(m.writes).toEqual([{ op: "update", data: { venue: "powerleague  shoreditch." } }]);
    expect(m.schedule).not.toHaveBeenCalled();
  });
});

describe("createActivity", () => {
  const form = { orgId: "org-a", sportId: "sport-a", name: "Tuesday 7s", dayOfWeek: 2, time: "21:00", venue: "Goals North Cheam" };

  it("every venue-location column a client adds is ignored", async () => {
    await createActivity({ ...form, ...SNEAKY } as never);
    expect(m.writes).toHaveLength(1);
    const written = m.writes[0].data;
    for (const column of COLUMNS) expect(written, column).not.toHaveProperty(column);
    expect(written).toMatchObject({ orgId: "org-a", venue: "Goals North Cheam", name: "Tuesday 7s" });
    expect(Object.keys(written).sort()).toEqual(
      ["dayOfWeek", "deadlineHours", "matchDurationMins", "name", "orgId", "ratingWindowHours", "sportId", "time", "venue"].sort(),
    );
  });

  it("the new game's venue is looked up after the save", async () => {
    await createActivity(form);
    expect(m.schedule).toHaveBeenCalledWith("act-new");
  });
});

// ── A venue picked from the suggestions under the venue box (2026-10-13) ──

describe("a venue picked from the suggestions", () => {
  const PICK = { placeId: "ChIJ_croydon_0001", sessionToken: "3f2c1d7e-8a4b-4c1d-9e2f-0a1b2c3d4e5f" };
  /** What a hostile browser might add to a pick. None of it may travel on. */
  const DRESSED_UP = { ...PICK, lat: 1, lng: 2, formattedAddress: "Attacker Lane", venueId: "attacker-pin", confidence: "high" };
  const CLEARED = {
    venueId: null,
    venueConfidence: null,
    venueMatchSource: null,
    venueLookupStatus: null,
    venueResolvedAt: null,
    venueConfirmedAt: null,
    venueConfirmedById: null,
  };
  const form = { orgId: "org-a", sportId: "sport-a", name: "Tuesday 7s", dayOfWeek: 2, time: "21:00", venue: "Powerleague Croydon" };

  it("createActivity: the game is saved with the typed text only, and the SERVER looks the picked place up afterwards", async () => {
    await createActivity({ ...form, venuePick: DRESSED_UP } as never);
    expect(Object.keys(m.writes[0].data).sort()).toEqual(
      ["dayOfWeek", "deadlineHours", "matchDurationMins", "name", "orgId", "ratingWindowHours", "sportId", "time", "venue"].sort(),
    );
    expect(m.writes[0].data.venue).toBe("Powerleague Croydon");
    expect(m.schedulePick).toHaveBeenCalledTimes(1);
    expect(m.schedulePick).toHaveBeenCalledWith("act-new", "owner-a", PICK);
    expect(m.schedule).not.toHaveBeenCalled();
  });

  it("updateActivity: new venue words with a pick clear the old place in the same write, then the picked place is looked up", async () => {
    await updateActivity("act-a", { venue: "Powerleague Croydon", venuePick: DRESSED_UP } as never);
    expect(m.writes).toEqual([{ op: "update", data: { venue: "Powerleague Croydon", ...CLEARED } }]);
    expect(m.schedulePick).toHaveBeenCalledWith("act-a", "owner-a", PICK);
    expect(m.schedule).not.toHaveBeenCalled();
    expect(m.dropPin).toHaveBeenCalledWith("venue-old");
  });

  it("updateActivity: a pick for the SAME words still replaces the place that was linked (the organiser chose this exact one)", async () => {
    await updateActivity("act-a", { venue: "Powerleague Shoreditch", venuePick: PICK });
    expect(m.writes).toEqual([{ op: "update", data: { venue: "Powerleague Shoreditch", ...CLEARED } }]);
    expect(m.schedulePick).toHaveBeenCalledWith("act-a", "owner-a", PICK);
  });

  it("updateActivity: a pick with NO venue text in the same request is ignored (a pick belongs to the text it was picked for)", async () => {
    await updateActivity("act-a", { time: "21:00", venuePick: PICK });
    expect(m.writes).toEqual([{ op: "update", data: { time: "21:00" } }]);
    expect(m.schedulePick).not.toHaveBeenCalled();
    expect(m.schedule).not.toHaveBeenCalled();
  });

  it.each([
    ["a place id that is not one", { placeId: "../../etc/passwd", sessionToken: "x" }],
    ["a bare string", "ChIJ_croydon_0001"],
    ["null", null],
    ["an array", ["ChIJ_croydon_0001"]],
  ])("%s is not a pick: the save goes through as FREE TEXT and the text is looked up", async (_label, venuePick) => {
    await createActivity({ ...form, venuePick } as never);
    expect(m.writes).toHaveLength(1);
    expect(m.schedulePick).not.toHaveBeenCalled();
    expect(m.schedule).toHaveBeenCalledWith("act-new");

    m.schedule.mockClear();
    await updateActivity("act-a", { venue: "Goals North Cheam", venuePick } as never);
    expect(m.schedulePick).not.toHaveBeenCalled();
    expect(m.schedule).toHaveBeenCalledWith("act-a");
  });

  it("free text with no pick is exactly as before", async () => {
    await createActivity({ ...form, venue: "School cage behind the library" });
    expect(m.writes[0].data.venue).toBe("School cage behind the library");
    expect(m.schedule).toHaveBeenCalledWith("act-new");
    expect(m.schedulePick).not.toHaveBeenCalled();
  });
});
