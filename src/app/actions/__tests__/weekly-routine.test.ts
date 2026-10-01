/**
 * /admin/settings "Weekly routine" (2026-09-30): the one server action
 * every weekly-routine setting goes through. Slice 1 has one key, the
 * rolling squad; slices 2 and 3 add theirs to the same action.
 *
 * auth / db / org / next-cache are mocked: no live DB.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const authMock = vi.fn();
const orgUpdate = vi.fn();
const orgFindUnique = vi.fn();
const activityFindMany = vi.fn();
const requireOrgAdmin = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/db", () => ({
  db: {
    organisation: {
      update: (...a: unknown[]) => orgUpdate(...a),
      findUnique: (...a: unknown[]) => orgFindUnique(...a),
      findUniqueOrThrow: (...a: unknown[]) => orgFindUnique(...a),
    },
    activity: { findMany: (...a: unknown[]) => activityFindMany(...a) },
  },
}));
vi.mock("@/lib/org", () => ({
  isSuperadmin: vi.fn(),
  getCurrentOrgId: vi.fn(),
  setCurrentOrgId: vi.fn(),
  requireOrgAdmin: (...a: unknown[]) => requireOrgAdmin(...a),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const saveAdminChannelChoice = vi.fn();
vi.mock("@/lib/admin-channel", () => ({
  saveAdminChannelChoice: (...a: unknown[]) => saveAdminChannelChoice(...a),
}));

const { setWeeklyRoutine } = await import("../org");

const UNSET_ROW = {
  rollingSquadEnabled: true,
  dropOutDeadlineDay: null,
  dropOutDeadlineTime: null,
  listPublishDay: null,
  listPublishTime: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "u-hamzah" } });
  orgUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...UNSET_ROW, ...data }));
  orgFindUnique.mockResolvedValue({ ...UNSET_ROW });
  activityFindMany.mockResolvedValue([{ dayOfWeek: 5, time: "20:30" }]);
  requireOrgAdmin.mockResolvedValue(undefined);
});

describe("setWeeklyRoutine", () => {
  it("turns the rolling squad on for an admin", async () => {
    const res = await setWeeklyRoutine("org-fnf", { rollingSquad: true });
    expect(requireOrgAdmin).toHaveBeenCalledWith("u-hamzah", "org-fnf");
    expect(orgUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "org-fnf" }, data: { rollingSquadEnabled: true } }),
    );
    expect(res).toMatchObject({ rollingSquad: true });
  });

  it("refuses a non-admin", async () => {
    requireOrgAdmin.mockRejectedValue(new Error("Admin access required"));
    await expect(setWeeklyRoutine("org-fnf", { rollingSquad: true })).rejects.toThrow("Admin access required");
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller", async () => {
    authMock.mockResolvedValue(null);
    await expect(setWeeklyRoutine("org-fnf", { rollingSquad: true })).rejects.toThrow("Not authenticated");
  });

  it("refuses an empty or malformed patch rather than writing nothing silently", async () => {
    await expect(setWeeklyRoutine("org-fnf", {})).rejects.toThrow();
    await expect(
      setWeeklyRoutine("org-fnf", { rollingSquad: "yes" } as unknown as { rollingSquad: boolean }),
    ).rejects.toThrow();
    expect(orgUpdate).not.toHaveBeenCalled();
  });
});

describe("setWeeklyRoutine: weekly deadlines (slice 3)", () => {
  it("sets the Friday group's Monday 21:00 drop-out deadline and Tuesday 20:00 list", async () => {
    const res = await setWeeklyRoutine("org-fnf", {
      dropOutDeadline: { day: 1, time: "21:00" },
      listPublish: { day: 2, time: "20:00" },
    });
    expect(orgUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "org-fnf" },
        data: { dropOutDeadlineDay: 1, dropOutDeadlineTime: "21:00", listPublishDay: 2, listPublishTime: "20:00" },
      }),
    );
    expect(activityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: "org-fnf", isActive: true } }),
    );
    expect(res).toEqual({
      ok: true,
      rollingSquad: true,
      dropOutDeadline: { day: 1, time: "21:00" },
      listPublish: { day: 2, time: "20:00" },
      // Slice 2b: read back with every patch; unset rows read as today.
      benchPickMode: "first-come",
      benchPickFallback: "bench-offer",
    });
  });

  it("validates against the setting already saved: a new drop-out deadline after the saved list time is refused", async () => {
    orgFindUnique.mockResolvedValue({ ...UNSET_ROW, listPublishDay: 2, listPublishTime: "20:00" });
    const res = await setWeeklyRoutine("org-fnf", { dropOutDeadline: { day: 3, time: "21:00" } });
    expect(res).toMatchObject({ error: "order" });
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it("refuses a time on match day after kickoff, and a time outside 08:00 to 21:30", async () => {
    expect(await setWeeklyRoutine("org-fnf", { listPublish: { day: 5, time: "21:00" } })).toMatchObject({
      error: "after-kickoff",
    });
    expect(await setWeeklyRoutine("org-fnf", { dropOutDeadline: { day: 1, time: "23:00" } })).toMatchObject({
      error: "outside-hours",
    });
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it("null clears a pair and returns the club to today's behaviour", async () => {
    orgFindUnique.mockResolvedValue({ ...UNSET_ROW, dropOutDeadlineDay: 1, dropOutDeadlineTime: "21:00" });
    const res = await setWeeklyRoutine("org-fnf", { dropOutDeadline: null });
    expect(orgUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { dropOutDeadlineDay: null, dropOutDeadlineTime: null } }),
    );
    expect(res).toMatchObject({ dropOutDeadline: null });
  });

  it("refuses a malformed pair outright", async () => {
    await expect(
      setWeeklyRoutine("org-fnf", { dropOutDeadline: { day: "Monday", time: "21:00" } } as unknown as {
        dropOutDeadline: { day: number; time: string };
      }),
    ).resolves.toMatchObject({ error: "bad-value" });
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it("refuses a non-admin before reading anything", async () => {
    requireOrgAdmin.mockRejectedValue(new Error("Admin access required"));
    await expect(setWeeklyRoutine("org-fnf", { dropOutDeadline: { day: 1, time: "21:00" } })).rejects.toThrow(
      "Admin access required",
    );
    expect(orgFindUnique).not.toHaveBeenCalled();
  });
});

describe("setWeeklyRoutine: slice 2a, where admin messages go", () => {
  it("saves the admin channel through the same action, with the admin check first", async () => {
    saveAdminChannelChoice.mockResolvedValue({ ok: true });
    const res = await setWeeklyRoutine("org-fnf", { adminChannel: { mode: "one-person", userId: "u-wasim" } });
    expect(requireOrgAdmin).toHaveBeenCalledWith("u-hamzah", "org-fnf");
    expect(saveAdminChannelChoice).toHaveBeenCalledWith("org-fnf", "one-person", "u-wasim");
    expect(res).toMatchObject({ ok: true, adminChannel: { ok: true } });
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it("passes on 'needs-link' for the admin group before a group is linked", async () => {
    saveAdminChannelChoice.mockResolvedValue({ ok: false, reason: "needs-link" });
    const res = await setWeeklyRoutine("org-fnf", { adminChannel: { mode: "admin-group", userId: null } });
    expect(res).toMatchObject({ ok: true, adminChannel: { ok: false, reason: "needs-link" } });
  });

  it("both keys in one patch", async () => {
    saveAdminChannelChoice.mockResolvedValue({ ok: true });
    const res = await setWeeklyRoutine("org-fnf", { rollingSquad: true, adminChannel: { mode: "each-admin", userId: null } });
    expect(res).toMatchObject({ ok: true, rollingSquad: true, adminChannel: { ok: true } });
  });

  it("a malformed admin channel is refused, nothing written", async () => {
    await expect(
      setWeeklyRoutine("org-fnf", { adminChannel: "group" } as unknown as { adminChannel: { mode: string; userId: null } }),
    ).rejects.toThrow();
    expect(saveAdminChannelChoice).not.toHaveBeenCalled();
    expect(orgUpdate).not.toHaveBeenCalled();
  });
});

describe("setWeeklyRoutine: slice 2b, who fills an open place", () => {
  it("turns organiser pick on, and returns both pick settings", async () => {
    orgUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...UNSET_ROW,
      benchPickMode: "first-come",
      benchPickFallback: "bench-offer",
      ...data,
    }));
    const res = await setWeeklyRoutine("org-fnf", { benchPickMode: "organiser" });
    expect(orgUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { benchPickMode: "organiser" } }));
    expect(res).toMatchObject({ ok: true, benchPickMode: "organiser", benchPickFallback: "bench-offer" });
  });

  it("sets the fallback to leave the place open", async () => {
    await setWeeklyRoutine("org-fnf", { benchPickFallback: "leave-empty" });
    expect(orgUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { benchPickFallback: "leave-empty" } }));
  });

  it("refuses a value that is not one of the choices, nothing written", async () => {
    await expect(setWeeklyRoutine("org-fnf", { benchPickMode: "random" as "organiser" })).rejects.toThrow();
    await expect(setWeeklyRoutine("org-fnf", { benchPickFallback: "maybe" as "leave-empty" })).rejects.toThrow();
    expect(orgUpdate).not.toHaveBeenCalled();
  });
});
