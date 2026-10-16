/**
 * THE ADMIN GROUP INTRODUCTION, the database half (2026-10-15):
 *
 *   introduceOnLink   the link command's one reply: the intro, claimed
 *                     once per club and group (`hq-intro:<orgId>:<groupId>`);
 *   sendHqIntro       `scripts/send-hq-intro.ts`: the same intro for a group
 *                     linked before this, queued as ONE `admin-group`
 *                     BotJob, claiming the same key. Dry run by default.
 *
 * Against a mocked database. No model anywhere.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  keys: new Set<string>(),
  jobs: [] as Array<Record<string, unknown>>,
  org: null as Record<string, unknown> | null,
  days: [5] as number[],
  canPost: true as boolean | null,
}));

const dbMock = vi.hoisted(() => {
  const m = {
    organisation: { findUnique: vi.fn() },
    activity: { findMany: vi.fn() },
    sentNotification: { createMany: vi.fn(), findUnique: vi.fn() },
    botJob: { create: vi.fn() },
    groupPostState: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  };
  return m;
});
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/group-postability-store", () => ({
  isGroupPostable: vi.fn(async () => state.canPost !== false),
}));

import { hqIntroKey, introduceOnLink, sendHqIntro } from "../admin-group-intro";
import { buildAdminGroupIntro } from "../admin-group-help";

const HQ = "120363900000000001@g.us";
const FNF = {
  id: "org-fnf",
  name: "FNF",
  language: "en",
  whatsappBotEnabled: true,
  squadMode: "weekly",
  benchPickMode: "organiser",
  listAnnouncer: "organisers",
  teamsReadyTime: null,
  featureAttendance: true,
  featureMomVoting: true,
  featurePlayerRating: true,
  adminGroupId: HQ,
  adminChannelMode: "admin-group",
};
const FNF_INTRO = buildAdminGroupIntro({ ...FNF, activityDays: [5] });

beforeEach(() => {
  vi.clearAllMocks();
  state.keys = new Set();
  state.jobs = [];
  state.org = { ...FNF };
  state.days = [5];
  state.canPost = true;
  dbMock.organisation.findUnique.mockImplementation(async () => state.org);
  dbMock.activity.findMany.mockImplementation(async () => state.days.map((dayOfWeek) => ({ dayOfWeek })));
  dbMock.sentNotification.findUnique.mockImplementation(async (a: { where: { key: string } }) => (state.keys.has(a.where.key) ? { id: "x" } : null));
  dbMock.sentNotification.createMany.mockImplementation(async (a: { data: Array<{ key: string }> }) => {
    let count = 0;
    for (const d of a.data) if (!state.keys.has(d.key)) (state.keys.add(d.key), count++);
    return { count };
  });
  dbMock.botJob.create.mockImplementation(async (a: { data: Record<string, unknown> }) => {
    state.jobs.push(a.data);
    return { id: `job-${state.jobs.length}` };
  });
  dbMock.$transaction.mockImplementation(async (fn: (tx: typeof dbMock) => unknown) => fn(dbMock));
});

describe("hqIntroKey", () => {
  it("one per club and group", () => {
    expect(hqIntroKey("org-fnf", HQ)).toBe(`hq-intro:org-fnf:${HQ}`);
  });
});

describe("introduceOnLink", () => {
  it("the first time: the intro, built from the club's row and its active games' weekdays, and the key claimed", async () => {
    expect(await introduceOnLink("org-fnf", HQ)).toBe(FNF_INTRO);
    expect(state.keys.has(hqIntroKey("org-fnf", HQ))).toBe(true);
    expect(dbMock.activity.findMany.mock.calls[0][0]).toMatchObject({ where: { orgId: "org-fnf", isActive: true } });
    expect(state.jobs).toEqual([]);
  });

  it("already introduced (the group linked again): null, so the caller says the short line", async () => {
    state.keys.add(hqIntroKey("org-fnf", HQ));
    expect(await introduceOnLink("org-fnf", HQ)).toBeNull();
  });

  it("a database failure on the claim still introduces: a silent link is worse than a rare second intro", async () => {
    dbMock.sentNotification.createMany.mockRejectedValueOnce(new Error("connection reset"));
    expect(await introduceOnLink("org-fnf", HQ)).toBe(FNF_INTRO);
  });
});

describe("sendHqIntro (scripts/send-hq-intro.ts)", () => {
  it("dry run: prints the text and where it would go, writes nothing", async () => {
    const r = await sendHqIntro({ orgId: "org-fnf", apply: false });
    expect(r).toEqual({ status: "dry-run", orgId: "org-fnf", club: "FNF", groupId: HQ, key: hqIntroKey("org-fnf", HQ), text: FNF_INTRO });
    expect(state.keys.size).toBe(0);
    expect(state.jobs).toEqual([]);
  });

  it("--apply: claims the key and queues ONE admin-group BotJob with the same text", async () => {
    const r = await sendHqIntro({ orgId: "org-fnf", apply: true });
    expect(r).toMatchObject({ status: "queued", jobId: "job-1", text: FNF_INTRO });
    expect(state.jobs).toEqual([{ orgId: "org-fnf", kind: "admin-group", text: FNF_INTRO }]);
    expect(state.keys.has(hqIntroKey("org-fnf", HQ))).toBe(true);
  });

  it("never twice: a second --apply, or after the link's own intro, is refused", async () => {
    await sendHqIntro({ orgId: "org-fnf", apply: true });
    expect(await sendHqIntro({ orgId: "org-fnf", apply: true })).toMatchObject({ status: "refused", reason: "already-introduced" });
    expect(await sendHqIntro({ orgId: "org-fnf", apply: false })).toMatchObject({ status: "refused", reason: "already-introduced" });
    expect(state.jobs).toHaveLength(1);
  });

  it("refuses with no club, no linked group, admin messages not set to the group, or a group MatchTime cannot post in", async () => {
    state.org = null;
    expect(await sendHqIntro({ orgId: "nope", apply: true })).toMatchObject({ status: "refused", reason: "no-club" });
    state.org = { ...FNF, adminGroupId: null };
    expect(await sendHqIntro({ orgId: "org-fnf", apply: true })).toMatchObject({ status: "refused", reason: "no-admin-group" });
    state.org = { ...FNF, adminChannelMode: "one-person" };
    expect(await sendHqIntro({ orgId: "org-fnf", apply: true })).toMatchObject({ status: "refused", reason: "admin-messages-not-to-group" });
    state.org = { ...FNF };
    state.canPost = false;
    expect(await sendHqIntro({ orgId: "org-fnf", apply: true })).toMatchObject({ status: "refused", reason: "group-not-postable" });
    expect(state.jobs).toEqual([]);
    expect(state.keys.size).toBe(0);
  });

  it("a claim lost to a concurrent run between the check and the write queues nothing", async () => {
    dbMock.sentNotification.createMany.mockResolvedValueOnce({ count: 0 });
    expect(await sendHqIntro({ orgId: "org-fnf", apply: true })).toMatchObject({ status: "refused", reason: "already-introduced" });
    expect(state.jobs).toEqual([]);
  });

  describe("--mark-sent: the intro was posted by hand (FNF HQ, 2026-10-15)", () => {
    it("dry run: says what it would claim, writes nothing", async () => {
      expect(await sendHqIntro({ orgId: "org-fnf", apply: false, markSent: true })).toEqual({
        status: "dry-run-mark",
        orgId: "org-fnf",
        club: "FNF",
        groupId: HQ,
        key: hqIntroKey("org-fnf", HQ),
      });
      expect(state.keys.size).toBe(0);
      expect(state.jobs).toEqual([]);
    });

    it("--apply: claims the key only, queues no message; afterwards nothing can send the intro", async () => {
      expect(await sendHqIntro({ orgId: "org-fnf", apply: true, markSent: true })).toMatchObject({ status: "marked", key: hqIntroKey("org-fnf", HQ) });
      expect(state.jobs).toEqual([]);
      expect(dbMock.botJob.create).not.toHaveBeenCalled();
      expect(await sendHqIntro({ orgId: "org-fnf", apply: true })).toMatchObject({ status: "refused", reason: "already-introduced" });
      expect(await sendHqIntro({ orgId: "org-fnf", apply: true, markSent: true })).toMatchObject({ status: "refused", reason: "already-introduced" });
      expect(await introduceOnLink("org-fnf", HQ)).toBeNull();
      expect(state.jobs).toEqual([]);
    });

    it("refuses with no club or no linked group; needs neither the channel mode nor posting rights", async () => {
      state.org = null;
      expect(await sendHqIntro({ orgId: "nope", apply: true, markSent: true })).toMatchObject({ status: "refused", reason: "no-club" });
      state.org = { ...FNF, adminGroupId: null };
      expect(await sendHqIntro({ orgId: "org-fnf", apply: true, markSent: true })).toMatchObject({ status: "refused", reason: "no-admin-group" });
      state.org = { ...FNF, adminChannelMode: "one-person" };
      state.canPost = false;
      expect(await sendHqIntro({ orgId: "org-fnf", apply: true, markSent: true })).toMatchObject({ status: "marked" });
      expect(state.jobs).toEqual([]);
    });
  });
});
