/**
 * Who may press "Yes" and "Change" under a venue: the OWNER and ADMINs of
 * the activity's OWN club, and nobody else. A player of the club, a
 * member (or owner) of another club and a signed-out caller are refused
 * before anything is looked up or written.
 *
 * Everything around the actions is mocked: no database, no network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  session: null as { user: { id: string } } | null,
  activityOrg: "org-a" as string | null,
  admins: new Set<string>(),
  change: vi.fn(async () => ({ status: "found" as const })),
  confirm: vi.fn(async () => true),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => m.session }));
vi.mock("@/lib/db", () => ({
  db: { activity: { findUnique: async () => (m.activityOrg ? { orgId: m.activityOrg } : null) } },
}));
vi.mock("@/lib/org", () => ({
  isOrgAdmin: async (userId: string, orgId: string) => m.admins.has(`${userId}@${orgId}`),
}));
vi.mock("@/lib/venue-location", () => ({ changeActivityVenue: m.change, confirmActivityVenue: m.confirm }));

import { changeVenueLocationAction, confirmVenueLocationAction } from "@/app/actions/venue-location";

beforeEach(() => {
  m.session = null;
  m.activityOrg = "org-a";
  m.admins = new Set(["owner-a@org-a", "owner-b@org-b"]);
  m.change.mockClear();
  m.confirm.mockClear();
});

describe.each([
  ["signed out", null],
  ["a player of the club", "player-a"],
  ["the owner of another club", "owner-b"],
])("%s", (_who, userId) => {
  beforeEach(() => {
    m.session = userId ? { user: { id: userId } } : null;
  });

  it("cannot confirm", async () => {
    expect(await confirmVenueLocationAction("act-a")).toEqual({ ok: false });
    expect(m.confirm).not.toHaveBeenCalled();
  });

  it("cannot change, and nothing is looked up", async () => {
    expect(await changeVenueLocationAction("act-a", "12 Whiston Road")).toEqual({ status: "error" });
    expect(m.change).not.toHaveBeenCalled();
  });
});

describe("the club's own admin", () => {
  beforeEach(() => {
    m.session = { user: { id: "owner-a" } };
  });

  it("confirms, as themselves", async () => {
    expect(await confirmVenueLocationAction("act-a")).toEqual({ ok: true });
    expect(m.confirm).toHaveBeenCalledWith("act-a", "owner-a");
  });

  it("changes, as themselves", async () => {
    expect(await changeVenueLocationAction("act-a", "12 Whiston Road")).toEqual({ status: "found" });
    expect(m.change).toHaveBeenCalledWith("act-a", "owner-a", "12 Whiston Road");
  });

  it("an activity that does not exist is refused", async () => {
    m.activityOrg = null;
    expect(await changeVenueLocationAction("nope", "x")).toEqual({ status: "error" });
    expect(await confirmVenueLocationAction("nope")).toEqual({ ok: false });
  });

  it("input that is not text is refused, and a failure inside becomes an outcome", async () => {
    expect(await changeVenueLocationAction("act-a", { evil: true } as unknown as string)).toEqual({ status: "error" });
    m.change.mockRejectedValueOnce(new Error("db down"));
    expect(await changeVenueLocationAction("act-a", "x")).toEqual({ status: "error" });
  });
});
