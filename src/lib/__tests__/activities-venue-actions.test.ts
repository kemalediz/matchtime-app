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
  dropPin: vi.fn(async () => undefined),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "owner-a" } }) }));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: async () => undefined }));
vi.mock("@/lib/venue-location", () => ({ dropOrphanPin: m.dropPin }));
vi.mock("@/lib/venue-location-schedule", () => ({ scheduleVenueResolve: m.schedule }));
vi.mock("@/lib/db", () => ({
  db: {
    sport: { findFirst: async () => ({ id: "sport-a" }) },
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
