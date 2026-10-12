/**
 * GO-LIVE SLICE S7: the admin group link command as the route runs it.
 * The command sent in the PLAYERS' group of a club that is still setting
 * up posts nothing there; its organiser is told by DM instead, once per
 * WhatsApp message and inside the setup-reply cap. Every other answer of
 * `linkAdminGroup` passes through untouched. Mocked database; the real
 * route against Postgres is in e2e/api/setup-followups.spec.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  keys: [] as Row[],
  jobs: [] as Row[],
  phone: "+447700900102" as string | null,
  known: true,
  repliesToday: 0,
  repliesThisHour: 0,
}));

const dbMock = vi.hoisted(() => ({
  sentNotification: {
    createMany: vi.fn(async ({ data }: { data: Row[] }) => {
      let count = 0;
      for (const d of data) {
        if (state.keys.some((k) => k.key === d.key)) continue;
        state.keys.push(d);
        count++;
      }
      return { count };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Row }) => {
      state.keys = state.keys.filter((k) => k.key !== where.key);
      return { count: 1 };
    }),
  },
  user: {
    findUnique: vi.fn(async () => ({ phoneNumber: state.phone })),
    findFirst: vi.fn(async () => (state.known ? { id: "u-raihan" } : null)),
  },
  platformJob: {
    // The cap counts "setup-reply" jobs to this number: the day first, then the hour.
    count: vi.fn(async ({ where }: { where: { createdAt: { gte: Date } } }) => {
      const windowMs = Date.now() - where.createdAt.gte.getTime();
      return windowMs > 2 * 60 * 60 * 1000 ? state.repliesToday : state.repliesThisHour;
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      state.jobs.push(data);
      return { id: `pj-${state.jobs.length}`, ...data };
    }),
  },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

const linkMock = vi.hoisted(() => vi.fn());
vi.mock("../admin-group-link", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../admin-group-link")>()),
  linkAdminGroup: linkMock,
}));

import { handleAdminGroupLinkCommand } from "../admin-group-link-command";

const PLAYERS = "120363900000000009@g.us";
const HQ = "120363900000000001@g.us";
const IN_PLAYERS_GROUP = {
  outcome: "ignored",
  replyText: null,
  reason: "club-setting-up",
  settingUpPlayersGroup: { orgId: "org-fnf", userId: "u-raihan", language: "en" },
};
const send = (over: Row = {}) =>
  handleAdminGroupLinkCommand({ groupId: PLAYERS, text: "Match Time admin group K7P3QX", messageId: "wamid-1", senderPhone: "447700900102", ...over });

let logs: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  state.keys = [];
  state.jobs = [];
  state.phone = "+447700900102";
  state.known = true;
  state.repliesToday = 0;
  state.repliesThisHour = 0;
  linkMock.mockResolvedValue(IN_PLAYERS_GROUP);
  logs = [];
  const keep = (...a: unknown[]) => void logs.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(" "));
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
});

describe("the command in the players' group of a club that is setting up", () => {
  it("answers the Pi with NO reply text (nothing is posted in that group), and no field of its own", async () => {
    expect(await send()).toEqual({ outcome: "ignored", replyText: null, reason: "club-setting-up" });
  });

  it("tells the organiser by platform DM, at once, in English", async () => {
    await send();
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toMatchObject({
      kind: "dm",
      phone: "447700900102",
      purpose: "setup-reply",
      refId: "org-fnf:admin-link-players-group:wamid-1",
      status: "queued",
      sendAfter: null,
      text: "That is your players' group, so it can't be the admin group. Add me to a separate group for the admins and send the message there.",
    });
  });

  it("in Turkish for a Turkish club", async () => {
    linkMock.mockResolvedValue({ ...IN_PLAYERS_GROUP, settingUpPlayersGroup: { orgId: "org-fnf", userId: "u-raihan", language: "tr" } });
    await send();
    expect(state.jobs[0].text).toBe(
      "Orası oyuncularınızın grubu, bu yüzden yönetici grubu olamaz. Beni yöneticiler için ayrı bir gruba ekleyin ve mesajı orada gönderin.",
    );
  });

  it("the Pi forwarding the same message twice: one DM", async () => {
    await send();
    expect(await send()).toEqual({ outcome: "ignored", replyText: null, reason: "club-setting-up" });
    expect(state.jobs).toHaveLength(1);
  });

  it("over the setup-reply cap (5 an hour, 15 a day): silence", async () => {
    state.repliesToday = 15;
    await send();
    state.repliesToday = 6;
    state.repliesThisHour = 5;
    await send({ messageId: "wamid-2" });
    expect(state.jobs).toEqual([]);
  });

  it("the organiser's account has no number, or the channel refuses it: nothing queued, and the command still answers", async () => {
    state.phone = null;
    expect(await send()).toMatchObject({ outcome: "ignored", replyText: null });
    state.phone = "+447700900102";
    state.known = false;
    expect(await send({ messageId: "wamid-2" })).toMatchObject({ outcome: "ignored", replyText: null });
    expect(state.jobs).toEqual([]);
  });

  it("a database failure while queueing does not fail the command, and releases the message's claim", async () => {
    dbMock.platformJob.create.mockRejectedValueOnce(new Error("connection reset"));
    expect(await send()).toEqual({ outcome: "ignored", replyText: null, reason: "club-setting-up" });
    expect(state.keys).toEqual([]);
    await send();
    expect(state.jobs).toHaveLength(1);
  });

  it("logs carry the club's id and an outcome code only", async () => {
    await send();
    const all = logs.join("\n");
    expect(all).toContain("org-fnf");
    expect(all).not.toMatch(/447700900102|K7P3QX|players' group, so/);
  });
});

describe("every other answer passes through untouched, and nobody is DMed", () => {
  const others = [
    { outcome: "linked", replyText: "✅ Linked as the admin group for *Friday FNF*.", adminGroup: { groupId: HQ, orgId: "org-fnf" } },
    { outcome: "already-linked", replyText: null, adminGroup: { groupId: HQ, orgId: "org-fnf" } },
    { outcome: "bad-code", replyText: "That code isn't valid any more." },
    { outcome: "main-group", replyText: "This is *Friday FNF*'s main group" },
    { outcome: "ignored", replyText: null, reason: "not-an-admin" },
    { outcome: "ignored", replyText: null, reason: "another-clubs-main-group" },
  ];
  for (const answer of others) {
    it(`${answer.outcome}${"reason" in answer ? ` (${answer.reason})` : ""}`, async () => {
      linkMock.mockResolvedValue(answer);
      expect(await send({ groupId: HQ })).toEqual(answer);
      expect(state.jobs).toEqual([]);
      expect(dbMock.sentNotification.createMany).not.toHaveBeenCalled();
    });
  }

  it("the message id is not passed on as anything linkAdminGroup acts on: it gets the same input", async () => {
    await send({ groupId: HQ, botMentioned: true });
    expect(linkMock.mock.calls[0][0]).toMatchObject({ groupId: HQ, text: "Match Time admin group K7P3QX", botMentioned: true });
  });
});
