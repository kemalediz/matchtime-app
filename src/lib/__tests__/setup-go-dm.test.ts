/**
 * GO by DM and the "not recognised" reply (go-live slice S4): the
 * decisions, with the database and the go-live writer mocked. The real
 * route, the real transaction and the race are in
 * e2e/api/setup-go-live.spec.ts. No network, no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  membership: { findMany: vi.fn() },
  sentNotification: { create: vi.fn(), deleteMany: vi.fn() },
  user: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("../db", () => ({ db: dbMock }));

const resolveSenderUserIds = vi.hoisted(() => vi.fn());
vi.mock("../admin-group-link", () => ({ resolveSenderUserIds }));

const queuePlatformDm = vi.hoisted(() => vi.fn());
vi.mock("../platform-jobs", () => ({
  queuePlatformDm,
  PlatformDmRefused: class PlatformDmRefused extends Error {
    constructor(readonly reason: string) {
      super(reason);
    }
  },
}));

const goLiveClub = vi.hoisted(() => vi.fn());
vi.mock("../club-setup", async () => ({
  ...(await vi.importActual<typeof import("../club-setup-rules")>("../club-setup-rules")),
  goLiveClub,
}));

const buildAdminLink = vi.hoisted(() => vi.fn());
vi.mock("../admin-link", () => ({ buildAdminLink, appUrl: (p: string) => `https://matchtime.test${p}` }));

const handleDmHelp = vi.hoisted(() => vi.fn());
vi.mock("../dm-help", () => ({ handleDmHelp }));

import { goReplyText, handleGoDm, handleSettingUpDm } from "../setup-go-dm";
import { en } from "../i18n/strings.en";
import { tr } from "../i18n/strings.tr";

const NOW = new Date("2026-10-12T12:00:00Z");
const held = (id: string, name: string, language = "en") => ({
  userId: "u-hana",
  orgId: id,
  user: { phoneNumber: "+447700900971" },
  org: { id, name, language, liveAt: null, approvalStatus: "approved", setupStage: "setting-up" },
});
const justLive = (id: string, name: string, minsAgo: number) => ({
  userId: "u-hana",
  orgId: id,
  user: { phoneNumber: "+447700900971" },
  org: { id, name, language: "en", liveAt: new Date(NOW.getTime() - minsAgo * 60_000), approvalStatus: "approved", setupStage: "live" },
});
const info = { orgId: "o1", club: "Harbour FC", group: "Harbour Tuesday 6s", language: "en" };
const go = (text: string) => handleGoDm({ text, phone: "447700900971", waMessageId: "wa-1", now: NOW });

beforeEach(() => {
  vi.clearAllMocks();
  resolveSenderUserIds.mockResolvedValue(["u-hana"]);
  dbMock.sentNotification.create.mockResolvedValue({});
  dbMock.sentNotification.deleteMany.mockResolvedValue({ count: 1 });
  dbMock.user.findUnique.mockResolvedValue({ phoneNumber: "+447700900971" });
  queuePlatformDm.mockResolvedValue({ id: "pj1" });
  buildAdminLink.mockResolvedValue("https://matchtime.test/r/abc");
});

describe("the replies to GO, word for word", () => {
  const cases: Array<[string, Parameters<typeof goReplyText>[0], string, string]> = [
    [
      "went live",
      { ...info, outcome: "went-live", liveAt: NOW, liveBy: "u", hello: "hi", purgedJobs: 0, quietedMatches: 0 },
      `Done: I've introduced myself in "Harbour Tuesday 6s".`,
      `Tamam: "Harbour Tuesday 6s" grubunda kendimi tanıttım.`,
    ],
    [
      "still reading",
      { ...info, outcome: "still-reading" },
      `I'm still reading your group's messages. Give me a few minutes and I'll message you.`,
      `Grubunuzdaki mesajları hâlâ okuyorum. Bana birkaç dakika verin, size yazacağım.`,
    ],
    [
      "removed from the group",
      { ...info, outcome: "removed-from-group" },
      `I'm not in "Harbour Tuesday 6s" any more. Add me back, then reply GO.`,
      `Artık "Harbour Tuesday 6s" grubunda değilim. Beni tekrar ekleyin, sonra BAŞLA yazın.`,
    ],
    [
      "already live",
      { ...info, outcome: "already-live", liveAt: NOW, liveBy: "u" },
      `Harbour FC is already live.`,
      `Harbour FC zaten yayında.`,
    ],
  ];
  it.each(cases)("%s", (_label, result, english, turkish) => {
    expect(goReplyText(result)).toBe(english);
    expect(goReplyText({ ...result, language: "tr" } as typeof result)).toBe(turkish);
  });

  it("a club that is not setting up gets no reply at all", () => {
    expect(goReplyText({ outcome: "not-setting-up", orgId: "o1" })).toBeNull();
  });

  it("more than one club, the button, and not recognised", () => {
    expect(en.sj_go_many).toBe(`You have more than one club being set up. Use the Go live button in each club's settings.`);
    expect(tr.sj_go_many).toBe(`Kurulumu süren birden fazla kulübünüz var. Her kulübün ayarlarındaki Yayına al düğmesini kullanın.`);
    expect([en.sj_go_button, tr.sj_go_button]).toEqual(["Go live", "Yayına al"]);
    expect(en.sj_go_not_recognised({ club: "Harbour FC", url: "https://x.test/r/1" })).toBe(
      `I didn't recognise that message. To go live with Harbour FC, reply *GO* here, or press *Go live* on the settings page:\nhttps://x.test/r/1`,
    );
    expect(tr.sj_go_not_recognised({ club: "Kıyı SK", url: "https://x.test/r/1" })).toBe(
      `Bu mesajı anlayamadım. Kıyı SK kulübünü yayına almak için buraya *BAŞLA* yazın ya da ayarlar sayfasındaki *Yayına al* düğmesine basın:\nhttps://x.test/r/1`,
    );
    const clubs = [
      { club: "Twin A", url: "https://x.test/r/1" },
      { club: "Twin B", url: "https://x.test/r/2" },
    ];
    expect(en.sj_go_not_recognised_many({ clubs })).toBe(
      `I didn't recognise that message. You have more than one club being set up, so press *Go live* in each club's settings:\nTwin A: https://x.test/r/1\nTwin B: https://x.test/r/2`,
    );
    expect(tr.sj_go_not_recognised_many({ clubs })).toBe(
      `Bu mesajı anlayamadım. Kurulumu süren birden fazla kulübünüz var, her kulübün ayarlarındaki *Yayına al* düğmesine basın:\nTwin A: https://x.test/r/1\nTwin B: https://x.test/r/2`,
    );
  });

  it("no em or en dash in any of them, in either language", () => {
    for (const table of [en, tr]) {
      const rendered = [
        table.sj_go_button,
        table.sj_go_done({ group: "G" }),
        table.sj_go_still_reading,
        table.sj_go_removed({ group: "G" }),
        table.sj_go_already_live({ club: "C" }),
        table.sj_go_many,
        table.sj_go_not_recognised({ club: "C", url: "u" }),
        table.sj_go_not_recognised_many({ clubs: [{ club: "C", url: "u" }] }),
      ].join("\n");
      expect(rendered).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("handleGoDm", () => {
  it("anything that is not GO costs nothing: no sender lookup, no query, no claim", async () => {
    for (const text of ["go on then", "in", "help", "yes", "GO now", "let's go"]) expect(await go(text)).toBeNull();
    expect(resolveSenderUserIds).not.toHaveBeenCalled();
    expect(dbMock.membership.findMany).not.toHaveBeenCalled();
    expect(dbMock.sentNotification.create).not.toHaveBeenCalled();
  });

  it("GO from somebody MatchTime does not know falls through, with no membership query", async () => {
    resolveSenderUserIds.mockResolvedValue([]);
    expect(await go("GO")).toBeNull();
    expect(dbMock.membership.findMany).not.toHaveBeenCalled();
  });

  it("the sender is resolved by phone or stored LID, never by display name", async () => {
    dbMock.membership.findMany.mockResolvedValue([]);
    await handleGoDm({ text: "go", phone: "447700900971", senderAltPhone: "447700900972", senderLid: "123@lid", waMessageId: "wa-1", now: NOW });
    expect(resolveSenderUserIds).toHaveBeenCalledWith({ phones: ["447700900971", "447700900972"], lid: "123@lid" });
  });

  it("only CURRENT owners and admins, of a club setting up or live for under ten minutes, are looked for", async () => {
    dbMock.membership.findMany.mockResolvedValue([]);
    expect(await go("GO")).toBeNull();
    const where = dbMock.membership.findMany.mock.calls[0][0].where;
    expect(where.userId).toEqual({ in: ["u-hana"] });
    expect(where.leftAt).toBeNull();
    expect(where.role).toEqual({ in: ["OWNER", "ADMIN"] });
    expect(where.org).toEqual({
      OR: [
        { approvalStatus: "approved", setupStage: "setting-up" },
        { approvalStatus: "approved", setupStage: "live", liveAt: { gte: new Date(NOW.getTime() - 10 * 60_000) } },
      ],
    });
    // Nothing matched: nothing claimed, nothing sent, the DM carries on.
    expect(dbMock.sentNotification.create).not.toHaveBeenCalled();
    expect(queuePlatformDm).not.toHaveBeenCalled();
  });

  it("one club setting up: it goes live, recorded against the sender's number, and the reply goes on the platform channel", async () => {
    dbMock.membership.findMany.mockResolvedValue([held("o1", "Harbour FC")]);
    goLiveClub.mockResolvedValue({ ...info, outcome: "went-live", liveAt: NOW, liveBy: "x", hello: "hi", purgedJobs: 2, quietedMatches: 0 });
    expect(await handleGoDm({ text: "GO", phone: "447700900971", waMessageId: "wa-1", now: NOW, learningEnabled: true })).toEqual({
      handled: "setup-go",
      outcome: "went-live",
      orgId: "o1",
    });
    expect(goLiveClub).toHaveBeenCalledWith("o1", "whatsapp:447700900971", NOW, { learningEnabled: true });
    expect(dbMock.sentNotification.create).toHaveBeenCalledWith({ data: { key: "setup-go-msg:wa-1", kind: "setup-go" } });
    expect(queuePlatformDm).toHaveBeenCalledTimes(1);
    expect(queuePlatformDm.mock.calls[0][0]).toMatchObject({
      phone: "+447700900971",
      purpose: "setup-reply",
      text: `Done: I've introduced myself in "Harbour Tuesday 6s".`,
    });
    // Immediate: a reply to the organiser's own message is never held for quiet hours.
    expect(queuePlatformDm.mock.calls[0][0].sendAfter).toBeUndefined();
  });

  it("a replayed WhatsApp message does nothing and sends nothing", async () => {
    dbMock.membership.findMany.mockResolvedValue([held("o1", "Harbour FC")]);
    dbMock.sentNotification.create.mockRejectedValue(new Error("unique"));
    expect(await go("GO")).toEqual({ handled: "setup-go-duplicate" });
    expect(goLiveClub).not.toHaveBeenCalled();
    expect(queuePlatformDm).not.toHaveBeenCalled();
  });

  it("more than one club setting up: none goes live, and the reply sends them to the button", async () => {
    dbMock.membership.findMany.mockResolvedValue([held("o1", "Twin A"), held("o2", "Twin B")]);
    expect(await go("GO")).toEqual({ handled: "setup-go", outcome: "more-than-one", orgId: null });
    expect(goLiveClub).not.toHaveBeenCalled();
    expect(queuePlatformDm.mock.calls[0][0].text).toBe(en.sj_go_many);
  });

  it("a club setting up beside one that has just gone live: the setting-up one goes live", async () => {
    dbMock.membership.findMany.mockResolvedValue([justLive("o9", "Just Live", 3), held("o1", "Harbour FC")]);
    goLiveClub.mockResolvedValue({ ...info, outcome: "went-live", liveAt: NOW, liveBy: "x", hello: "hi", purgedJobs: 0, quietedMatches: 0 });
    expect(await go("go live")).toMatchObject({ outcome: "went-live", orgId: "o1" });
    expect(goLiveClub.mock.calls[0][0]).toBe("o1");
  });

  it("only a club that went live a moment ago: the second admin is told it is already live, and nothing is written", async () => {
    dbMock.membership.findMany.mockResolvedValue([justLive("o9", "Just Live", 3)]);
    expect(await go("GO")).toEqual({ handled: "setup-go", outcome: "already-live", orgId: "o9" });
    expect(goLiveClub).not.toHaveBeenCalled();
    expect(queuePlatformDm.mock.calls[0][0].text).toBe("Just Live is already live.");
  });

  it("each refusal is answered in the club's language", async () => {
    dbMock.membership.findMany.mockResolvedValue([held("o1", "Kıyı SK", "tr")]);
    goLiveClub.mockResolvedValue({ orgId: "o1", club: "Kıyı SK", group: "Kıyı Salı Maçı", language: "tr", outcome: "still-reading" });
    expect(await go("BAŞLA")).toMatchObject({ outcome: "still-reading" });
    expect(queuePlatformDm.mock.calls[0][0].text).toBe(tr.sj_go_still_reading);
  });

  it("a go-live that throws releases the claim, so the Pi's retry can try again", async () => {
    dbMock.membership.findMany.mockResolvedValue([held("o1", "Harbour FC")]);
    goLiveClub.mockRejectedValue(new Error("database down"));
    await expect(go("GO")).rejects.toThrow("database down");
    expect(dbMock.sentNotification.deleteMany).toHaveBeenCalledWith({ where: { key: "setup-go-msg:wa-1" } });
    expect(queuePlatformDm).not.toHaveBeenCalled();
  });

  it("a reply that cannot be queued does not undo the go-live", async () => {
    dbMock.membership.findMany.mockResolvedValue([held("o1", "Harbour FC")]);
    goLiveClub.mockResolvedValue({ ...info, outcome: "went-live", liveAt: NOW, liveBy: "x", hello: "hi", purgedJobs: 0, quietedMatches: 0 });
    queuePlatformDm.mockRejectedValue(new Error("queue down"));
    expect(await go("GO")).toMatchObject({ handled: "setup-go", outcome: "went-live" });
    expect(dbMock.sentNotification.deleteMany).not.toHaveBeenCalled();
  });
});

describe("handleSettingUpDm: the sender the setting-up rail stopped", () => {
  const args = (over: Partial<Parameters<typeof handleSettingUpDm>[0]> = {}) => ({
    userId: "u-hana",
    text: "when do we start?",
    phone: "447700900971",
    waMessageId: "wa-2",
    isHelpRequest: false,
    ...over,
  });
  const runs = (id: string, name: string, language = "en") => ({ orgId: id, org: { id, name, language } });

  it("a sender not verified by phone or stored LID (display name only) gets silence, and nothing is read or queued", async () => {
    resolveSenderUserIds.mockResolvedValue([]);
    expect(await handleSettingUpDm(args())).toEqual({ ignored: "club-setting-up" });
    expect(dbMock.membership.findMany).not.toHaveBeenCalled();
    expect(queuePlatformDm).not.toHaveBeenCalled();
  });

  it("a plain member gets silence: only current owners and admins of a setting-up club are answered", async () => {
    dbMock.membership.findMany.mockResolvedValue([]);
    expect(await handleSettingUpDm(args())).toEqual({ ignored: "club-setting-up" });
    expect(await handleSettingUpDm(args({ isHelpRequest: true, text: "help" }))).toEqual({ ignored: "club-setting-up" });
    const where = dbMock.membership.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ userId: "u-hana", leftAt: null, role: { in: ["OWNER", "ADMIN"] } });
    expect(where.org).toEqual({ approvalStatus: "approved", setupStage: "setting-up" });
    expect(dbMock.sentNotification.create).not.toHaveBeenCalled();
    expect(handleDmHelp).not.toHaveBeenCalled();
    expect(queuePlatformDm).not.toHaveBeenCalled();
  });

  it("an owner or admin is told it was not recognised, with their own signed-in settings link, at once", async () => {
    dbMock.membership.findMany.mockResolvedValue([runs("o1", "Harbour FC")]);
    expect(await handleSettingUpDm(args())).toEqual({ handled: "setup-not-recognised", orgIds: ["o1"] });
    expect(buildAdminLink).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-hana", orgId: "o1", nextPath: "/admin/settings" }));
    expect(queuePlatformDm).toHaveBeenCalledTimes(1);
    const sent = queuePlatformDm.mock.calls[0][0];
    expect(sent).toMatchObject({ phone: "+447700900971", purpose: "setup-reply" });
    expect(sent.sendAfter).toBeUndefined();
    expect(sent.text).toBe(en.sj_go_not_recognised({ club: "Harbour FC", url: "https://matchtime.test/r/abc" }));
  });

  it("no throttle: every new message is answered, and only a replay of the same message is not", async () => {
    dbMock.membership.findMany.mockResolvedValue([runs("o1", "Harbour FC")]);
    for (const id of ["wa-a", "wa-b", "wa-c"]) await handleSettingUpDm(args({ waMessageId: id }));
    expect(queuePlatformDm).toHaveBeenCalledTimes(3);
    dbMock.sentNotification.create.mockRejectedValueOnce(new Error("unique"));
    expect(await handleSettingUpDm(args({ waMessageId: "wa-a" }))).toEqual({ handled: "setup-dm-duplicate" });
    expect(queuePlatformDm).toHaveBeenCalledTimes(3);
  });

  it("more than one club: each club's own link is listed", async () => {
    dbMock.membership.findMany.mockResolvedValue([runs("o1", "Twin A"), runs("o2", "Twin B")]);
    buildAdminLink.mockImplementation(async (a: { orgId: string }) => `https://matchtime.test/r/${a.orgId}`);
    expect(await handleSettingUpDm(args())).toEqual({ handled: "setup-not-recognised", orgIds: ["o1", "o2"] });
    expect(queuePlatformDm.mock.calls[0][0].text).toBe(
      en.sj_go_not_recognised_many({
        clubs: [
          { club: "Twin A", url: "https://matchtime.test/r/o1" },
          { club: "Twin B", url: "https://matchtime.test/r/o2" },
        ],
      }),
    );
  });

  it("the Turkish club's organiser is answered in Turkish", async () => {
    dbMock.membership.findMany.mockResolvedValue([runs("o1", "Kıyı SK", "tr")]);
    await handleSettingUpDm(args());
    expect(queuePlatformDm.mock.calls[0][0].text).toBe(tr.sj_go_not_recognised({ club: "Kıyı SK", url: "https://matchtime.test/r/abc" }));
  });

  it("a signed-in link that cannot be minted falls back to the plain address", async () => {
    dbMock.membership.findMany.mockResolvedValue([runs("o1", "Harbour FC")]);
    buildAdminLink.mockRejectedValue(new Error("no secret"));
    await handleSettingUpDm(args());
    expect(queuePlatformDm.mock.calls[0][0].text).toContain("https://matchtime.test/admin/settings");
  });

  it("a help request is answered with the help, delivered on the platform channel, not with 'not recognised'", async () => {
    dbMock.membership.findMany.mockResolvedValue([runs("o1", "Harbour FC")]);
    handleDmHelp.mockResolvedValue({ handled: "dm-help", topic: null, orgId: "o1", audience: "admin" });
    expect(await handleSettingUpDm(args({ isHelpRequest: true, text: "help" }))).toEqual({
      handled: "dm-help",
      topic: null,
      orgId: "o1",
      audience: "admin",
    });
    expect(handleDmHelp).toHaveBeenCalledWith({ userId: "u-hana", text: "help", envelopePhone: "447700900971", deliver: "platform" });
    expect(queuePlatformDm).not.toHaveBeenCalled();
  });
});
