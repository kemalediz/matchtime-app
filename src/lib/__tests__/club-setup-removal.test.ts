/**
 * MATCHTIME REMOVED FROM, AND ADDED BACK TO, THE GROUP OF A CLUB THAT IS
 * STILL SETTING UP (src/lib/club-setup-removal.ts): every branch, with
 * everything round it mocked. The real database, the real approval and the
 * real routes are in e2e/helpers/setup-removal-lib-tests.ts and
 * e2e/api/setup-go-live.spec.ts.
 *
 * Also the rule for what may be LOGGED here: the club's id and reason
 * codes. Never its name, the group's name, a phone number, a LID, the
 * message text or a link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  clubConnect: { findFirst: vi.fn() },
  membership: { findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("../db", () => ({ db: dbMock }));

const setup = vi.hoisted(() => ({
  findSettingUpClubByGroup: vi.fn(),
  markSetupRemoved: vi.fn(),
  clearSetupRemoved: vi.fn(),
  unaskCancelledSetupDm: vi.fn(),
}));
vi.mock("../club-setup", () => setup);

const cancelSetupDm = vi.hoisted(() => vi.fn());
vi.mock("../club-setup-dm-cancel", () => ({ cancelSetupDm }));

const clearCapturedChatForClub = vi.hoisted(() => vi.fn());
vi.mock("../captured-chat", () => ({ clearCapturedChatForClub }));

const recordOpsEvent = vi.hoisted(() => vi.fn());
vi.mock("../ops-alerts", () => ({ SETUP_ALERT_KIND: "club-setup", recordOpsEvent }));

const jobs = vi.hoisted(() => {
  class PlatformDmRefused extends Error {
    constructor(
      readonly reason: string,
      readonly code: string = "number-not-known",
    ) {
      super(reason);
    }
  }
  return { PlatformDmRefused, queuePlatformDm: vi.fn(), cancelQueuedPlatformDms: vi.fn() };
});
vi.mock("../platform-jobs", () => jobs);

const resolveSenderUserIds = vi.hoisted(() => vi.fn());
vi.mock("../admin-group-link", () => ({ resolveSenderUserIds }));
vi.mock("../admin-link", () => ({ appUrl: (p: string) => `https://matchtime.test${p}` }));

import { SETUP_REMOVED_DM_PURPOSE, handleSetupReAdd, handleSetupRemoval, setupRemovedRefId } from "../club-setup-removal";

const GROUP = "120363900000000777@g.us";
const NOON = new Date("2026-07-14T11:00:00Z"); // 12:00 London
const NIGHT = new Date("2026-07-14T23:10:00Z"); // 00:10 London
const NINE = new Date("2026-07-15T08:00:00Z"); // 09:00 London
const CLUB = { id: "org-harbour", name: "Harbour FC", language: "en", removedAt: null as Date | null };
const PHONE = "447700900971";
const LID = "99887766554433";
const SECRETS = ["Harbour FC", "Harbour Tuesday 6s", PHONE, LID, "matchtime.test", "I was removed", "Lou Organiser"];

let logs: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  setup.findSettingUpClubByGroup.mockResolvedValue({ ...CLUB });
  setup.markSetupRemoved.mockResolvedValue(true);
  setup.clearSetupRemoved.mockResolvedValue(true);
  setup.unaskCancelledSetupDm.mockResolvedValue(true);
  cancelSetupDm.mockResolvedValue({ cancelled: 0, alreadyClaimed: 0 });
  clearCapturedChatForClub.mockResolvedValue(1);
  recordOpsEvent.mockResolvedValue(true);
  jobs.queuePlatformDm.mockResolvedValue({ id: "pj-1" });
  jobs.cancelQueuedPlatformDms.mockResolvedValue({ cancelled: 0, alreadyClaimed: 0 });
  dbMock.clubConnect.findFirst.mockResolvedValue({ phone: PHONE, groupSubject: "Harbour Tuesday 6s" });
  dbMock.membership.findFirst.mockResolvedValue({ id: "m-1" });
  resolveSenderUserIds.mockResolvedValue(["u-lou"]);
  logs = [];
  const keep = (...a: unknown[]) => void logs.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : String(x))).join(" "));
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
  vi.spyOn(console, "warn").mockImplementation(keep);
});
afterEach(() => vi.restoreAllMocks());

/** Every line logged names the club by id and says nothing else about it. */
function expectLogsCarryIdsAndCodesOnly() {
  expect(logs.length).toBeGreaterThan(0);
  for (const line of logs) {
    expect(line, line).toContain("org-harbour");
    for (const secret of SECRETS) expect(line, line).not.toContain(secret);
  }
}

describe("handleSetupRemoval", () => {
  it("no club that is setting up owns the group: nothing is written, said or recorded", async () => {
    setup.findSettingUpClubByGroup.mockResolvedValue(null);
    expect(await handleSetupRemoval(GROUP, { now: NOON })).toEqual({ kind: "not-setting-up" });
    for (const f of [setup.markSetupRemoved, cancelSetupDm, clearCapturedChatForClub, recordOpsEvent, jobs.queuePlatformDm]) {
      expect(f).not.toHaveBeenCalled();
    }
    expect(logs).toEqual([]);
  });

  it("already stamped (a repeated report, or another worker won): nothing more is done or said", async () => {
    setup.markSetupRemoved.mockResolvedValue(false);
    expect(await handleSetupRemoval(GROUP, { now: NOON })).toEqual({ kind: "already-removed", orgId: "org-harbour" });
    for (const f of [cancelSetupDm, clearCapturedChatForClub, recordOpsEvent, jobs.queuePlatformDm]) expect(f).not.toHaveBeenCalled();
  });

  it("the stamp comes FIRST, then the cancel, the chat, the organiser's DM and the owner's event", async () => {
    const order: string[] = [];
    setup.markSetupRemoved.mockImplementation(async () => (order.push("stamp"), true));
    cancelSetupDm.mockImplementation(async () => (order.push("cancel"), { cancelled: 0, alreadyClaimed: 0 }));
    clearCapturedChatForClub.mockImplementation(async () => (order.push("chat"), 1));
    jobs.queuePlatformDm.mockImplementation(async () => (order.push("dm"), { id: "pj-1" }));
    recordOpsEvent.mockImplementation(async () => (order.push("event"), true));
    expect(await handleSetupRemoval(GROUP, { now: NOON })).toEqual({
      kind: "removed",
      orgId: "org-harbour",
      setupDm: "none-waiting",
      organiserDm: "queued",
    });
    expect(order).toEqual(["stamp", "cancel", "chat", "dm", "event"]);
    expect(setup.markSetupRemoved).toHaveBeenCalledWith("org-harbour", NOON);
    expect(cancelSetupDm).toHaveBeenCalledWith("org-harbour", "removed", NOON);
    expect(clearCapturedChatForClub).toHaveBeenCalledWith(dbMock, "org-harbour");
  });

  it("the organiser's DM: the latest closed connect request's number, the club's language, the group's own name, sent at once in the daytime", async () => {
    await handleSetupRemoval(GROUP, { now: NOON });
    expect(dbMock.clubConnect.findFirst).toHaveBeenCalledWith({
      where: { orgId: "org-harbour", status: "closed", linkedAt: { not: null } },
      orderBy: { linkedAt: "desc" },
      select: { phone: true, groupSubject: true },
    });
    expect(jobs.queuePlatformDm).toHaveBeenCalledTimes(1);
    expect(jobs.queuePlatformDm).toHaveBeenCalledWith({
      phone: PHONE,
      text:
        `I was removed from "Harbour Tuesday 6s" before Harbour FC went live, so nothing has started there. ` +
        `Add me back to the group, then reply *GO* here or press *Go live* on your settings page:\nhttps://matchtime.test/admin/settings`,
      purpose: SETUP_REMOVED_DM_PURPOSE,
      refId: setupRemovedRefId("org-harbour"),
      sendAfter: null,
    });
    expect([SETUP_REMOVED_DM_PURPOSE, setupRemovedRefId("org-harbour")]).toEqual(["setup-removed", "org-harbour:setup-removed"]);
  });

  it("at night it waits for 09:00 London; a Turkish club is told in Turkish, with BAŞLA; a group with no name is called by the club's", async () => {
    setup.findSettingUpClubByGroup.mockResolvedValue({ ...CLUB, name: "Kıyı SK", language: "tr" });
    dbMock.clubConnect.findFirst.mockResolvedValue({ phone: PHONE, groupSubject: "  " });
    await handleSetupRemoval(GROUP, { now: NIGHT });
    const arg = jobs.queuePlatformDm.mock.calls[0][0];
    expect(arg.sendAfter).toEqual(NINE);
    expect(arg.text).toBe(
      `Kıyı SK yayına geçmeden "Kıyı SK" grubundan çıkarıldım, bu yüzden orada hiçbir şey başlamadı. ` +
        `Beni gruba yeniden ekleyin, sonra buraya *BAŞLA* yazın ya da ayarlar sayfanızdaki *Yayına al* düğmesine basın:\nhttps://matchtime.test/admin/settings`,
    );
    expect(arg.text).not.toMatch(/[\u2013\u2014]/);
  });

  it("the setup DM was QUEUED and is cancelled: the club is made 'never asked' again, so a fresh one goes after the re-add", async () => {
    cancelSetupDm.mockResolvedValue({ cancelled: 1, alreadyClaimed: 0 });
    expect((await handleSetupRemoval(GROUP, { now: NIGHT })) as { setupDm: string }).toMatchObject({ setupDm: "cancelled-will-resend" });
    expect(setup.unaskCancelledSetupDm).toHaveBeenCalledWith("org-harbour");
  });

  it("the Pi had CLAIMED the setup DM: it may be on its way, so the club stays 'asked' and it is never queued twice", async () => {
    cancelSetupDm.mockResolvedValue({ cancelled: 0, alreadyClaimed: 1 });
    expect((await handleSetupRemoval(GROUP, { now: NOON })) as { setupDm: string }).toMatchObject({ setupDm: "left-with-the-pi" });
    expect(setup.unaskCancelledSetupDm).not.toHaveBeenCalled();
  });

  it("no setup DM was waiting (never sent, or already sent): the club's 'asked' state is not touched", async () => {
    expect((await handleSetupRemoval(GROUP, { now: NOON })) as { setupDm: string }).toMatchObject({ setupDm: "none-waiting" });
    expect(setup.unaskCancelledSetupDm).not.toHaveBeenCalled();
  });

  it("slices S6 and S7: the setup DM had GONE and only a queued reminder (or command) was taken back: the club stays 'asked', so no second setup DM", async () => {
    // What `cancelSetupDm` answers then: nothing about the setup DM itself.
    cancelSetupDm.mockResolvedValue({ cancelled: 0, alreadyClaimed: 0, followUps: { cancelled: 1, alreadyClaimed: 0 } });
    expect((await handleSetupRemoval(GROUP, { now: NIGHT })) as { setupDm: string }).toMatchObject({ setupDm: "none-waiting" });
    expect(setup.unaskCancelledSetupDm).not.toHaveBeenCalled();
  });

  it("the owner's event: one per removal, on the club, with codes and no names", async () => {
    cancelSetupDm.mockResolvedValue({ cancelled: 1, alreadyClaimed: 0 });
    await handleSetupRemoval(GROUP, { now: NOON });
    expect(recordOpsEvent).toHaveBeenCalledTimes(1);
    const e = recordOpsEvent.mock.calls[0][0];
    expect(e).toMatchObject({
      orgId: "org-harbour",
      kind: "club-setup",
      severity: "warning",
      title: "MatchTime removed from a club that is setting up",
      dedupeKey: `setup-removed:${NOON.toISOString()}`,
      now: NOON,
    });
    expect(e.detail).toContain("Organiser told: queued. Setup message: cancelled-will-resend.");
    for (const secret of SECRETS) expect(`${e.title} ${e.detail}`).not.toContain(secret);
  });

  it("no organiser on record: nobody is DMed, the owner's event says so, and the stamp stands", async () => {
    dbMock.clubConnect.findFirst.mockResolvedValue(null);
    expect(await handleSetupRemoval(GROUP, { now: NOON })).toMatchObject({ kind: "removed", organiserDm: "no-organiser" });
    expect(jobs.queuePlatformDm).not.toHaveBeenCalled();
    expect(recordOpsEvent.mock.calls[0][0].detail).toContain("Organiser told: no-organiser.");
  });

  it("the platform channel refuses the organiser's number: 'refused', logged by its CODE only", async () => {
    jobs.queuePlatformDm.mockRejectedValue(new jobs.PlatformDmRefused(`setup-removed: no MatchTime user has ${PHONE}`, "number-not-known"));
    expect(await handleSetupRemoval(GROUP, { now: NOON })).toMatchObject({ kind: "removed", organiserDm: "refused" });
    expect(logs.some((l) => l.includes("(number-not-known)"))).toBe(true);
    expectLogsCarryIdsAndCodesOnly();
  });

  it("every follow-up fails on its own and none undoes the stamp: a database error in each is logged by its NAME and the rest still run", async () => {
    const boom = (what: string) => Object.assign(new Error(`${what} failed for Harbour FC ${PHONE}`), { name: "PrismaClientKnownRequestError" });
    cancelSetupDm.mockRejectedValue(boom("cancel"));
    clearCapturedChatForClub.mockRejectedValue(boom("chat"));
    jobs.queuePlatformDm.mockRejectedValue(boom("dm"));
    const r = await handleSetupRemoval(GROUP, { now: NOON });
    expect(r).toEqual({ kind: "removed", orgId: "org-harbour", setupDm: "unknown", organiserDm: "failed" });
    expect(recordOpsEvent).toHaveBeenCalledTimes(1);
    expect(recordOpsEvent.mock.calls[0][0].detail).toContain("Organiser told: failed. Setup message: unknown.");
    expect(logs.filter((l) => l.includes("PrismaClientKnownRequestError"))).toHaveLength(3);
    expectLogsCarryIdsAndCodesOnly();
  });

  it("a failure to STAMP is thrown: the route fails and the Pi reports the removal again", async () => {
    setup.markSetupRemoved.mockRejectedValue(new Error("connection lost"));
    await expect(handleSetupRemoval(GROUP, { now: NOON })).rejects.toThrow("connection lost");
    expect(jobs.queuePlatformDm).not.toHaveBeenCalled();
  });

  it("LOGS: the happy path too carries the club's id and codes, nothing else", async () => {
    cancelSetupDm.mockResolvedValue({ cancelled: 1, alreadyClaimed: 0 });
    await handleSetupRemoval(GROUP, { now: NOON });
    expect(logs).toEqual(["[club-setup-removal] org-harbour: removed while setting up; setup DM cancelled-will-resend, organiser DM queued"]);
    expectLogsCarryIdsAndCodesOnly();
  });
});

describe("handleSetupReAdd", () => {
  const removed = { ...CLUB, removedAt: NOON };
  beforeEach(() => setup.findSettingUpClubByGroup.mockResolvedValue({ ...removed }));
  const add = (over: Record<string, unknown> = {}) => handleSetupReAdd({ groupId: GROUP, addedByPhone: PHONE, now: NIGHT, ...over });

  it("no setting-up club owns the group, or it was never removed: nothing is read further or written", async () => {
    setup.findSettingUpClubByGroup.mockResolvedValue(null);
    expect(await add()).toEqual({ kind: "not-removed" });
    setup.findSettingUpClubByGroup.mockResolvedValue({ ...CLUB, removedAt: null });
    expect(await add()).toEqual({ kind: "not-removed" });
    expect(resolveSenderUserIds).not.toHaveBeenCalled();
    expect(setup.clearSetupRemoved).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it("added by a current member (by phone): cleared for THAT group, and a removal DM still waiting is taken back", async () => {
    expect(await add()).toEqual({ kind: "cleared", orgId: "org-harbour" });
    expect(resolveSenderUserIds).toHaveBeenCalledWith({ phones: [PHONE], lid: null });
    expect(dbMock.membership.findFirst).toHaveBeenCalledWith({
      where: { orgId: "org-harbour", userId: { in: ["u-lou"] }, leftAt: null },
      select: { id: true },
    });
    expect(setup.clearSetupRemoved).toHaveBeenCalledWith("org-harbour", GROUP);
    expect(jobs.cancelQueuedPlatformDms).toHaveBeenCalledWith({
      purposes: ["setup-removed"],
      refIds: ["org-harbour:setup-removed"],
      reason: "re-added",
      now: NIGHT,
    });
    // Nothing is queued for anybody from here.
    expect(jobs.queuePlatformDm).not.toHaveBeenCalled();
  });

  it("added by a member known only by a server-stored LID", async () => {
    expect(await add({ addedByPhone: null, addedByLid: LID })).toEqual({ kind: "cleared", orgId: "org-harbour" });
    expect(resolveSenderUserIds).toHaveBeenCalledWith({ phones: [null], lid: LID });
  });

  it("added by somebody MatchTime does not know: still removed", async () => {
    resolveSenderUserIds.mockResolvedValue([]);
    expect(await add()).toEqual({ kind: "not-a-member", orgId: "org-harbour" });
    expect(dbMock.membership.findFirst).not.toHaveBeenCalled();
    expect(setup.clearSetupRemoved).not.toHaveBeenCalled();
  });

  it("added by a known person who is not a CURRENT member of this club: still removed", async () => {
    dbMock.membership.findFirst.mockResolvedValue(null);
    expect(await add()).toEqual({ kind: "not-a-member", orgId: "org-harbour" });
    expect(setup.clearSetupRemoved).not.toHaveBeenCalled();
    expect(jobs.cancelQueuedPlatformDms).not.toHaveBeenCalled();
  });

  it("no adder named at all (and not the sweep): nobody is looked up, still removed", async () => {
    expect(await add({ addedByPhone: "  ", addedByLid: undefined })).toEqual({ kind: "not-a-member", orgId: "org-harbour" });
    expect(resolveSenderUserIds).not.toHaveBeenCalled();
  });

  it("FOUND BY THE RECONNECT SWEEP in the club's own group: cleared with no adder, and nobody is looked up", async () => {
    expect(await handleSetupReAdd({ groupId: GROUP, discovered: true, now: NIGHT })).toEqual({ kind: "cleared", orgId: "org-harbour" });
    expect(resolveSenderUserIds).not.toHaveBeenCalled();
    expect(dbMock.membership.findFirst).not.toHaveBeenCalled();
    expect(setup.clearSetupRemoved).toHaveBeenCalledWith("org-harbour", GROUP);
    expect(logs.some((l) => l.includes("found by the reconnect sweep"))).toBe(true);
  });

  it("the sweep reporting a group of a club that was NOT removed clears nothing (there is nothing to clear)", async () => {
    setup.findSettingUpClubByGroup.mockResolvedValue({ ...CLUB, removedAt: null });
    expect(await handleSetupReAdd({ groupId: GROUP, discovered: true, now: NIGHT })).toEqual({ kind: "not-removed" });
    expect(setup.clearSetupRemoved).not.toHaveBeenCalled();
  });

  it("the compare-and-set finds nothing (cleared a moment ago, or the club went live): not-removed, and no DM is taken back", async () => {
    setup.clearSetupRemoved.mockResolvedValue(false);
    expect(await add()).toEqual({ kind: "not-removed" });
    expect(jobs.cancelQueuedPlatformDms).not.toHaveBeenCalled();
  });

  it("taking the removal DM back fails: the club is still cleared, and the failure is logged by its name", async () => {
    jobs.cancelQueuedPlatformDms.mockRejectedValue(Object.assign(new Error(`could not reach ${PHONE}`), { name: "PrismaClientKnownRequestError" }));
    expect(await add()).toEqual({ kind: "cleared", orgId: "org-harbour" });
    expect(logs.some((l) => l.includes("PrismaClientKnownRequestError"))).toBe(true);
    expectLogsCarryIdsAndCodesOnly();
  });

  it("LOGS: cleared and refused both carry the club's id and a reason, nothing else", async () => {
    await add();
    dbMock.membership.findFirst.mockResolvedValue(null);
    await add();
    expect(logs).toEqual([
      "[club-setup-removal] org-harbour: back in its group (added by a member); the club can go live again",
      "[club-setup-removal] org-harbour: added back by somebody who is not a member of the club; still removed",
    ]);
    expectLogsCarryIdsAndCodesOnly();
  });
});
