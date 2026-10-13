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
  changeToPick: vi.fn(async () => ({ status: "found" as string })),
  confirm: vi.fn(async () => true),
  retry: vi.fn(async () => ({ status: "found" as string })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => m.session }));
vi.mock("@/lib/db", () => ({
  db: { activity: { findUnique: async () => (m.activityOrg ? { orgId: m.activityOrg } : null) } },
}));
vi.mock("@/lib/org", () => ({
  isOrgAdmin: async (userId: string, orgId: string) => m.admins.has(`${userId}@${orgId}`),
}));
vi.mock("@/lib/venue-location", () => ({
  changeActivityVenue: m.change,
  changeActivityVenueToPick: m.changeToPick,
  confirmActivityVenue: m.confirm,
  resolveActivityVenueSafe: m.retry,
}));

import { changeVenueLocationAction, confirmVenueLocationAction, retryVenueLookupAction } from "@/app/actions/venue-location";

beforeEach(() => {
  m.session = null;
  m.activityOrg = "org-a";
  m.admins = new Set(["owner-a@org-a", "owner-b@org-b"]);
  m.change.mockClear();
  m.changeToPick.mockClear();
  m.changeToPick.mockResolvedValue({ status: "found" });
  m.confirm.mockClear();
  m.retry.mockClear();
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

  it("cannot ask for another try, and nothing is looked up", async () => {
    expect(await retryVenueLookupAction("act-a")).toEqual({ ok: false });
    expect(m.retry).not.toHaveBeenCalled();
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

  it("tries the lookup again, and says whether it could be made this time", async () => {
    expect(await retryVenueLookupAction("act-a")).toEqual({ ok: true });
    expect(m.retry).toHaveBeenCalledWith("act-a");
    m.retry.mockResolvedValueOnce({ status: "error" });
    expect(await retryVenueLookupAction("act-a")).toEqual({ ok: false });
    m.retry.mockResolvedValueOnce({ status: "capped" });
    expect(await retryVenueLookupAction("act-a")).toEqual({ ok: false });
  });

  it("changes, as themselves", async () => {
    expect(await changeVenueLocationAction("act-a", "12 Whiston Road")).toEqual({ status: "found" });
    expect(m.change).toHaveBeenCalledWith("act-a", "owner-a", "12 Whiston Road");
  });

  // A place picked from the suggestions in the Change box (2026-10-13).
  const PICK = { placeId: "ChIJ_croydon_0001", sessionToken: "3f2c1d7e-8a4b-4c1d-9e2f-0a1b2c3d4e5f" };

  it("changes to a place picked from the suggestions: only the place id and the session token travel on", async () => {
    const sent = { ...PICK, lat: 1, lng: 2, formattedAddress: "Attacker Lane" };
    expect(await changeVenueLocationAction("act-a", "Powerleague Croydon", sent as never)).toEqual({ status: "found" });
    expect(m.changeToPick).toHaveBeenCalledWith("act-a", "owner-a", PICK);
    expect(m.change).not.toHaveBeenCalled();
  });

  it("a picked place Google does not resolve: the typed words are looked up instead", async () => {
    m.changeToPick.mockResolvedValueOnce({ status: "unresolved" });
    expect(await changeVenueLocationAction("act-a", "Powerleague Croydon", PICK)).toEqual({ status: "found" });
    expect(m.change).toHaveBeenCalledWith("act-a", "owner-a", "Powerleague Croydon");
  });

  it("a picked place over the club's daily cap says so, and nothing else is looked up", async () => {
    m.changeToPick.mockResolvedValueOnce({ status: "capped" });
    expect(await changeVenueLocationAction("act-a", "Powerleague Croydon", PICK)).toEqual({ status: "capped" });
    expect(m.change).not.toHaveBeenCalled();
  });

  it("something that is not a pick is ignored: the words are looked up as before", async () => {
    expect(await changeVenueLocationAction("act-a", "12 Whiston Road", { placeId: "../x" } as never)).toEqual({ status: "found" });
    expect(m.changeToPick).not.toHaveBeenCalled();
    expect(m.change).toHaveBeenCalledWith("act-a", "owner-a", "12 Whiston Road");
  });

  it("someone who is not the club's admin cannot change by a pick either", async () => {
    m.session = { user: { id: "player-a" } };
    expect(await changeVenueLocationAction("act-a", "Powerleague Croydon", PICK)).toEqual({ status: "error" });
    expect(m.changeToPick).not.toHaveBeenCalled();
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
