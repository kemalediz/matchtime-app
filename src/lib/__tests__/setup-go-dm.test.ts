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
  platformJob: { count: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("../db", () => ({ db: dbMock }));

const resolveSenderUserIds = vi.hoisted(() => vi.fn());
vi.mock("../admin-group-link", () => ({ resolveSenderUserIds }));

const platform = vi.hoisted(() => {
  class PlatformDmRefused extends Error {
    constructor(
      readonly reason: string,
      readonly code: string = "number-not-known",
    ) {
      super(reason);
    }
  }
  return { queuePlatformDm: vi.fn(), PlatformDmRefused };
});
vi.mock("../platform-jobs", () => platform);
const { queuePlatformDm } = platform;

const goLiveClub = vi.hoisted(() => vi.fn());
vi.mock("../club-setup", async () => ({
  ...(await vi.importActual<typeof import("../club-setup-rules")>("../club-setup-rules")),
  goLiveClub,
}));

const buildAdminLink = vi.hoisted(() => vi.fn());
vi.mock("../admin-link", () => ({ buildAdminLink, appUrl: (p: string) => `https://matchtime.test${p}` }));

const handleDmHelp = vi.hoisted(() => vi.fn());
vi.mock("../dm-help", () => ({ handleDmHelp }));

import { SETUP_REPLY_CAPS, goReplyText, handleGoDm, handleSettingUpDm, setupReplyCapReached } from "../setup-go-dm";
import { en } from "../i18n/strings.en";
import { tr } from "../i18n/strings.tr";

const NOW = new Date("2026-10-12T12:00:00Z");
const SETTINGS = "https://matchtime.test/admin/settings";
const held = (id: string, name: string, language = "en") => ({
  userId: "u-hana",
  orgId: id,
  user: { phoneNumber: "+447700900971" },
  org: { id, name, language, liveAt: null, approvalStatus: "approved", setupStage: "setting-up" },
});
const wentLive = (id: string, name: string, minsAgo: number) => ({
  userId: "u-hana",
  orgId: id,
  user: { phoneNumber: "+447700900971" },
  org: { id, name, language: "en", liveAt: new Date(NOW.getTime() - minsAgo * 60_000), approvalStatus: "approved", setupStage: "live" },
});
const info = { orgId: "o1", club: "Harbour FC", group: "Harbour Tuesday 6s", language: "en" };
const LIVE = {
  ...info,
  outcome: "went-live" as const,
  liveAt: NOW,
  liveBy: "u-hana",
  hello: "hi",
  purgedJobs: 0,
  quietedMatches: 0,
  freePeriodStarted: false,
  freePeriodNote: null as string | null,
};
const go = (text: string) => handleGoDm({ text, phone: "447700900971", waMessageId: "wa-1", now: NOW });
const unique = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

/** Replies already queued or sent to the number: in the last day, and in the last hour. */
function repliesSoFar(day: number, hour: number) {
  dbMock.platformJob.count.mockImplementation(async (args: { where: { createdAt: { gte: Date } } }) =>
    NOW.getTime() - args.where.createdAt.gte.getTime() > 2 * 3_600_000 ? day : hour,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveSenderUserIds.mockResolvedValue(["u-hana"]);
  dbMock.sentNotification.create.mockResolvedValue({});
  dbMock.sentNotification.deleteMany.mockResolvedValue({ count: 1 });
  dbMock.user.findUnique.mockResolvedValue({ phoneNumber: "+447700900971" });
  repliesSoFar(0, 0);
  queuePlatformDm.mockResolvedValue({ id: "pj1" });
});

describe("the replies to GO, word for word", () => {
  const cases: Array<[string, Parameters<typeof goReplyText>[0], string, string]> = [
    // Item 3: the hello is queued, not posted. The Pi posts it after its
    // next refresh, up to five minutes later, so "I've introduced myself"
    // could be read minutes before anything appears.
    ["went live", LIVE, `Done: I'm introducing myself in "Harbour Tuesday 6s" now. It can take a few minutes to appear.`, `Tamam: şimdi "Harbour Tuesday 6s" grubunda kendimi tanıtıyorum. Mesajın görünmesi birkaç dakika sürebilir.`],
    [
      "still reading",
      { ...info, outcome: "still-reading" },
      // Item 2: no "a few minutes" (it can be two hours) and no "I'll
      // message you" (the setup message goes to whoever connected the club).
      `I'm still reading your group's messages, which can take a while. When I've finished I'll send the setup message to the organiser who connected Harbour FC. Try *GO* again after that.`,
      `Grubunuzdaki mesajları hâlâ okuyorum, bu biraz sürebilir. Bitirdiğimde kurulum mesajını Harbour FC kulübünü bağlayan organizatöre göndereceğim. Ondan sonra yeniden *BAŞLA* yazın.`,
    ],
    [
      "removed from the group",
      { ...info, outcome: "removed-from-group" },
      `I'm not in "Harbour Tuesday 6s" any more. Add me back, then reply GO.`,
      `Artık "Harbour Tuesday 6s" grubunda değilim. Beni tekrar ekleyin, sonra BAŞLA yazın.`,
    ],
    ["already live", { ...info, outcome: "already-live", liveAt: NOW, liveBy: "u" }, `Harbour FC is already live.`, `Harbour FC zaten yayında.`],
    [
      "paused for the club fee",
      { ...info, outcome: "billing-paused" },
      `Harbour FC is paused, so I can't go live yet. Your settings page shows what's needed:\n${SETTINGS}`,
      `Harbour FC şu anda duraklatılmış, bu yüzden henüz yayına alamıyorum. Ne gerektiği ayarlar sayfanızda yazıyor:\n${SETTINGS}`,
    ],
  ];
  it.each(cases)("%s", (_label, result, english, turkish) => {
    expect(goReplyText(result)).toBe(english);
    expect(goReplyText({ ...result, language: "tr" } as typeof result)).toBe(turkish);
  });

  it("went live AND its free period started: 'Done' is followed, in the same message, by the free period and the club fee tip", () => {
    const note = "Your first two months are free.\n\nAfter that MatchTime costs up to £9.99 a month.";
    expect(goReplyText({ ...LIVE, freePeriodStarted: true, freePeriodNote: note })).toBe(`Done: I'm introducing myself in "Harbour Tuesday 6s" now. It can take a few minutes to appear.\n\n${note}`);
    // No free period started (billing off, plan Free, one already running): just "Done".
    expect(goReplyText({ ...LIVE, freePeriodStarted: false, freePeriodNote: null })).toBe(`Done: I'm introducing myself in "Harbour Tuesday 6s" now. It can take a few minutes to appear.`);
  });

  it("a club that is not setting up gets no reply at all", () => {
    expect(goReplyText({ outcome: "not-setting-up", orgId: "o1" })).toBeNull();
  });

  it("more than one club, the button, and not recognised", () => {
    expect(en.sj_go_many).toBe(`You have more than one club being set up. Use the Go live button in each club's settings.`);
    expect(tr.sj_go_many).toBe(`Kurulumu süren birden fazla kulübünüz var. Her kulübün ayarlarındaki Yayına al düğmesini kullanın.`);
    expect([en.sj_go_button, tr.sj_go_button]).toEqual(["Go live", "Yayına al"]);
    expect(en.sj_go_not_recognised({ club: "Harbour FC", url: SETTINGS })).toBe(
      `I didn't recognise that message. To go live with Harbour FC, reply *GO* here, or press *Go live* on the settings page:\n${SETTINGS}`,
    );
    expect(tr.sj_go_not_recognised({ club: "Kıyı SK", url: SETTINGS })).toBe(
      `Bu mesajı anlayamadım. Kıyı SK kulübünü yayına almak için buraya *BAŞLA* yazın ya da ayarlar sayfasındaki *Yayına al* düğmesine basın:\n${SETTINGS}`,
    );
    expect(en.sj_go_not_recognised_many({ url: SETTINGS })).toBe(
      `I didn't recognise that message. You have more than one club being set up, so press *Go live* in each club's settings:\n${SETTINGS}`,
    );
    expect(tr.sj_go_not_recognised_many({ url: SETTINGS })).toBe(
      `Bu mesajı anlayamadım. Kurulumu süren birden fazla kulübünüz var, her kulübün ayarlarındaki *Yayına al* düğmesine basın:\n${SETTINGS}`,
    );
  });

  it("no em or en dash in any of them, in either language", () => {
    for (const table of [en, tr]) {
      const rendered = [
        table.sj_go_button,
        table.sj_go_done({ group: "G" }),
        table.sj_go_still_reading({ club: "C" }),
        table.sj_go_failed,
        table.sj_go_help_not_started,
        table.sj_go_owner_started({ group: "G" }),
        table.sj_go_removed({ group: "G" }),
        table.sj_go_already_live({ club: "C" }),
        table.sj_go_many,
        table.sj_go_not_recognised({ club: "C", url: "u" }),
        table.sj_go_not_recognised_many({ url: "u" }),
        table.sj_go_paused({ club: "C", url: "u" }),
      ].join("\n");
      expect(rendered).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("the reply cap (PR #234 review, fix 1a)", () => {
  it("is 5 in any hour and 15 in any day", () => {
    expect(SETUP_REPLY_CAPS).toEqual({ perHour: 5, perDay: 15 });
  });

  it.each([
    [0, 0, false],
    [4, 4, false],
    [5, 5, true],
    [14, 4, false],
    [15, 0, true],
    [9, 5, true],
  ])("%i in the last day, %i in the last hour: reached %s", async (day, hour, reached) => {
    repliesSoFar(day, hour);
    expect(await setupReplyCapReached("+447700900971", NOW)).toBe(reached);
  });

  it("counts the setup replies queued or sent to that number, never a failed one", async () => {
    repliesSoFar(6, 0);
    await setupReplyCapReached("+44 7700 900971", NOW);
    const [day, hour] = dbMock.platformJob.count.mock.calls.map((c) => c[0].where);
    for (const where of [day, hour]) {
      expect(where).toMatchObject({
        kind: "dm",
        phone: "447700900971",
        purpose: "setup-reply",
        status: { in: ["queued", "claimed", "sent", "unconfirmed"] },
      });
    }
    expect(day.createdAt).toEqual({ gte: new Date(NOW.getTime() - 24 * 3_600_000) });
    expect(hour.createdAt).toEqual({ gte: new Date(NOW.getTime() - 3_600_000) });
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

  it("only CURRENT owners and admins are looked for, of a club setting up or one that has been through the hold", async () => {
    dbMock.membership.findMany.mockResolvedValue([]);
    expect(await go("GO")).toBeNull();
    const where = dbMock.membership.findMany.mock.calls[0][0].where;
    expect(where.userId).toEqual({ in: ["u-hana"] });
    expect(where.leftAt).toBeNull();
    expect(where.role).toEqual({ in: ["OWNER", "ADMIN"] });
    // No time limit on the second half; and a club that was never held
    // (no go-live stamp: every club that exists today) matches neither.
    expect(where.org).toEqual({
      OR: [
        { approvalStatus: "approved", setupStage: "setting-up" },
        { approvalStatus: "approved", setupStage: "live", liveAt: { not: null } },
      ],
    });
    // Nothing matched: nothing claimed, nothing sent, the DM carries on.
    expect(dbMock.sentNotification.create).not.toHaveBeenCalled();
    expect(queuePlatformDm).not.toHaveBeenCalled();
  });

  it("one club setting up: it goes live, recorded against the USER, and the reply goes on the platform channel", async () => {
    dbMock.membership.findMany.mockResolvedValue([held("o1", "Harbour FC")]);
    goLiveClub.mockResolvedValue(LIVE);
    expect(
      await handleGoDm({ text: "*GO*", phone: "447700900971", waMessageId: "wa-1", now: NOW, learningEnabled: true, billingEnabled: true }),
    ).toEqual({ handled: "setup-go", outcome: "went-live", orgId: "o1" });
    // Review fix 7: the resolved user, with the phone number kept out of it.
    expect(goLiveClub).toHaveBeenCalledWith("o1", "u-hana", NOW, { learningEnabled: true, billingEnabled: true });
    expect(dbMock.sentNotification.create).toHaveBeenCalledWith({ data: { key: "setup-go-msg:wa-1", kind: "setup-go" } });
    expect(queuePlatformDm).toHaveBeenCalledTimes(1);
    expect(queuePlatformDm.mock.calls[0][0]).toMatchObject({
      phone: "+447700900971",
      purpose: "setup-reply",
      text: `Done: I'm introducing myself in "Harbour Tuesday 6s" now. It can take a few minutes to appear.`,
    });
    // Immediate: a reply to the organiser's own message is never held for quiet hours.
    expect(queuePlatformDm.mock.calls[0][0].sendAfter).toBeUndefined();
  });

  it("'Done' is said even when the cap is reached: it happens once, and the organiser must know", async () => {
    dbMock.membership.findMany.mockResolvedValue([held("o1", "Harbour FC")]);
    goLiveClub.mockResolvedValue(LIVE);
    repliesSoFar(15, 5);
    await go("GO");
    expect(queuePlatformDm).toHaveBeenCalledTimes(1);
    expect(dbMock.platformJob.count).not.toHaveBeenCalled();
  });

  it("a refusal is capped: GO sent over and over while still reading stops being answered, and nothing else changes", async () => {
    dbMock.membership.findMany.mockResolvedValue([held("o1", "Harbour FC")]);
    goLiveClub.mockResolvedValue({ ...info, outcome: "still-reading" });
    repliesSoFar(5, 5);
    expect(await go("GO")).toEqual({ handled: "setup-go", outcome: "still-reading", orgId: "o1" });
    expect(queuePlatformDm).not.toHaveBeenCalled();
  });

  it("a replayed WhatsApp message (a unique violation on the claim) does nothing and sends nothing", async () => {
    dbMock.membership.findMany.mockResolvedValue([held("o1", "Harbour FC")]);
    dbMock.sentNotification.create.mockRejectedValue(unique());
    expect(await go("GO")).toEqual({ handled: "setup-go-duplicate" });
    expect(goLiveClub).not.toHaveBeenCalled();
    expect(queuePlatformDm).not.toHaveBeenCalled();
  });

  it("review fix 5: any OTHER database error on the claim is not a duplicate: it surfaces, so the Pi retries", async () => {
    dbMock.membership.findMany.mockResolvedValue([held("o1", "Harbour FC")]);
    dbMock.sentNotification.create.mockRejectedValue(new Error("connection terminated"));
    await expect(go("GO")).rejects.toThrow("connection terminated");
    expect(goLiveClub).not.toHaveBeenCalled();
  });

  it("more than one club setting up: none goes live, and the reply sends them to the button", async () => {
    dbMock.membership.findMany.mockResolvedValue([held("o1", "Twin A"), held("o2", "Twin B")]);
    expect(await go("GO")).toEqual({ handled: "setup-go", outcome: "more-than-one", orgId: null });
    expect(goLiveClub).not.toHaveBeenCalled();
    expect(queuePlatformDm.mock.calls[0][0].text).toBe(en.sj_go_many);
  });

  it("a club setting up beside one that is live already: the setting-up one goes live", async () => {
    dbMock.membership.findMany.mockResolvedValue([wentLive("o9", "Just Live", 3), held("o1", "Harbour FC")]);
    goLiveClub.mockResolvedValue(LIVE);
    expect(await go("go live")).toMatchObject({ outcome: "went-live", orgId: "o1" });
    expect(goLiveClub.mock.calls[0][0]).toBe("o1");
  });

  it("review fix 6: a club that went live through the hold answers 'already live' however long ago, and nothing is written", async () => {
    dbMock.membership.findMany.mockResolvedValue([wentLive("o9", "Long Live", 60 * 24 * 90)]);
    expect(await go("GO")).toEqual({ handled: "setup-go", outcome: "already-live", orgId: "o9" });
    expect(goLiveClub).not.toHaveBeenCalled();
    expect(queuePlatformDm.mock.calls[0][0].text).toBe("Long Live is already live.");
  });

  it("each refusal is answered in the club's language", async () => {
    dbMock.membership.findMany.mockResolvedValue([held("o1", "Kıyı SK", "tr")]);
    goLiveClub.mockResolvedValue({ orgId: "o1", club: "Kıyı SK", group: "Kıyı Salı Maçı", language: "tr", outcome: "still-reading" });
    expect(await go("BAŞLA")).toMatchObject({ outcome: "still-reading" });
    expect(queuePlatformDm.mock.calls[0][0].text).toBe(tr.sj_go_still_reading({ club: "Kıyı SK" }));
  });

  it("paused for the club fee: refused, and the organiser is pointed at the settings page", async () => {
    dbMock.membership.findMany.mockResolvedValue([held("o1", "Harbour FC")]);
    goLiveClub.mockResolvedValue({ ...info, outcome: "billing-paused" });
    expect(await go("GO")).toMatchObject({ outcome: "billing-paused" });
    expect(queuePlatformDm.mock.calls[0][0].text).toBe(en.sj_go_paused({ club: "Harbour FC", url: SETTINGS }));
  });

  // Item 5. The Pi does NOT send a DM again when the server answers with
  // an error (`postDmReply` only logs), so a GO that fails is lost unless
  // the organiser says it again, and somebody has to tell them to.
  it("a go-live that throws: the claim is released, the organiser is asked to say GO again, and the error still surfaces", async () => {
    dbMock.membership.findMany.mockResolvedValue([held("o1", "Harbour FC")]);
    goLiveClub.mockRejectedValue(new Error("go-live failed"));
    await expect(go("GO")).rejects.toThrow("go-live failed");
    expect(dbMock.sentNotification.deleteMany).toHaveBeenCalledWith({ where: { key: "setup-go-msg:wa-1" } });
    expect(queuePlatformDm).toHaveBeenCalledTimes(1);
    expect(queuePlatformDm.mock.calls[0][0]).toMatchObject({
      phone: "+447700900971",
      purpose: "setup-reply",
      text: "Something went wrong on my side. Please reply *GO* again.",
    });
  });

  it("that apology is in the club's language, and is capped like every other setup reply", async () => {
    dbMock.membership.findMany.mockResolvedValue([held("o1", "Kıyı SK", "tr")]);
    goLiveClub.mockRejectedValue(new Error("go-live failed"));
    await expect(go("BAŞLA")).rejects.toThrow("go-live failed");
    expect(queuePlatformDm.mock.calls[0][0].text).toBe("Benim tarafımda bir sorun oldu. Lütfen yeniden *BAŞLA* yazın.");
    queuePlatformDm.mockClear();
    repliesSoFar(15, 5);
    await expect(handleGoDm({ text: "GO", phone: "447700900971", waMessageId: "wa-9", now: NOW })).rejects.toThrow("go-live failed");
    expect(queuePlatformDm).not.toHaveBeenCalled();
  });

  it("when the apology cannot be queued either (the database is down), the ORIGINAL error is what surfaces", async () => {
    dbMock.membership.findMany.mockResolvedValue([held("o1", "Harbour FC")]);
    goLiveClub.mockRejectedValue(new Error("database down"));
    queuePlatformDm.mockRejectedValue(new Error("queue down too"));
    await expect(go("GO")).rejects.toThrow("database down");
  });

  // Item 6. "Harbour FC is already live." to the admin of a club MatchTime
  // is not serving is false comfort: it has the paused wording.
  // Second walk, item 1. Three cases, three true answers. A club that is
  // LIVE and paused used to get the pre-live refusal, "is paused, so I
  // can't go live yet": it went live long ago.
  it("a club that went through the hold, is LIVE, and is now PAUSED: 'already live, but paused at the moment', never 'can't go live yet'", async () => {
    const paused = wentLive("o9", "Paused Park", 60 * 24 * 90);
    dbMock.membership.findMany.mockResolvedValue([{ ...paused, org: { ...paused.org, billingStatus: "paused" } }]);
    expect(
      await handleGoDm({ text: "GO", phone: "447700900971", waMessageId: "wa-1", now: NOW, billingEnabled: true }),
    ).toEqual({ handled: "setup-go", outcome: "already-live-paused", orgId: "o9" });
    expect(goLiveClub).not.toHaveBeenCalled();
    const text = queuePlatformDm.mock.calls[0][0].text as string;
    expect(text).toBe(`Paused Park is already live, but it is paused at the moment. Your settings page shows what's needed:\n${SETTINGS}`);
    expect(text).not.toContain("can't go live yet");
  });

  it("the same in Turkish", async () => {
    const paused = wentLive("o9", "Kıyı SK", 60 * 24 * 90);
    dbMock.membership.findMany.mockResolvedValue([{ ...paused, org: { ...paused.org, language: "tr", billingStatus: "paused" } }]);
    await handleGoDm({ text: "BAŞLA", phone: "447700900971", waMessageId: "wa-1", now: NOW, billingEnabled: true });
    expect(queuePlatformDm.mock.calls[0][0].text).toBe(
      `Kıyı SK zaten yayında, ancak şu anda duraklatılmış. Ne gerektiği ayarlar sayfanızda yazıyor:\n${SETTINGS}`,
    );
  });

  it("the three cases side by side: setting up and paused, live, live and paused", () => {
    expect(en.sj_go_paused({ club: "C", url: "u" })).toBe("C is paused, so I can't go live yet. Your settings page shows what's needed:\nu");
    expect(en.sj_go_already_live({ club: "C" })).toBe("C is already live.");
    expect(en.sj_go_live_paused({ club: "C", url: "u" })).toBe("C is already live, but it is paused at the moment. Your settings page shows what's needed:\nu");
    for (const table of [en, tr]) expect(table.sj_go_live_paused({ club: "C", url: "u" })).not.toMatch(/[\u2013\u2014]/);
  });

  it("with billing off nobody counts as paused: the same club is 'already live', as before", async () => {
    const paused = wentLive("o9", "Paused Park", 60);
    dbMock.membership.findMany.mockResolvedValue([{ ...paused, org: { ...paused.org, billingStatus: "paused" } }]);
    expect(
      await handleGoDm({ text: "GO", phone: "447700900971", waMessageId: "wa-1", now: NOW, billingEnabled: false }),
    ).toMatchObject({ outcome: "already-live" });
    expect(queuePlatformDm.mock.calls[0][0].text).toBe("Paused Park is already live.");
  });

  // Item 10: a refusal's own message can hold the raw number.
  it("LOGS: a refused reply is logged by its CODE, never by its reason (which can hold the number)", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
    try {
      dbMock.membership.findMany.mockResolvedValue([held("o1", "Harbour FC")]);
      goLiveClub.mockResolvedValue(LIVE);
      queuePlatformDm.mockRejectedValue(new platform.PlatformDmRefused(`not a phone number: "+44 7700 900971 x"`, "not-a-phone-number"));
      await go("GO");
      expect(errors.join("\n")).toContain("not-a-phone-number");
      expect(errors.join("\n")).not.toMatch(/7700|900971/);
    } finally {
      spy.mockRestore();
    }
  });

  it("a reply that cannot be queued does not undo the go-live", async () => {
    dbMock.membership.findMany.mockResolvedValue([held("o1", "Harbour FC")]);
    goLiveClub.mockResolvedValue(LIVE);
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
    now: NOW,
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
    expect(await handleSettingUpDm(args({ readHelp: async () => ({ topic: null }), text: "help" }))).toEqual({ ignored: "club-setting-up" });
    const where = dbMock.membership.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ userId: "u-hana", leftAt: null, role: { in: ["OWNER", "ADMIN"] } });
    expect(where.org).toEqual({ approvalStatus: "approved", setupStage: "setting-up" });
    expect(dbMock.sentNotification.create).not.toHaveBeenCalled();
    expect(handleDmHelp).not.toHaveBeenCalled();
    expect(queuePlatformDm).not.toHaveBeenCalled();
  });

  it("an owner or admin is told it was not recognised, at once, with the PLAIN settings address (review fix 1b)", async () => {
    dbMock.membership.findMany.mockResolvedValue([runs("o1", "Harbour FC")]);
    expect(await handleSettingUpDm(args())).toEqual({ handled: "setup-not-recognised", orgIds: ["o1"] });
    // No reusable sign-in link is minted for a message nobody understood.
    expect(buildAdminLink).not.toHaveBeenCalled();
    expect(queuePlatformDm).toHaveBeenCalledTimes(1);
    const sent = queuePlatformDm.mock.calls[0][0];
    expect(sent).toMatchObject({ phone: "+447700900971", purpose: "setup-reply" });
    expect(sent.sendAfter).toBeUndefined();
    expect(sent.text).toBe(en.sj_go_not_recognised({ club: "Harbour FC", url: SETTINGS }));
  });

  it("every new message is answered while under the cap; a replay of the same message is not", async () => {
    dbMock.membership.findMany.mockResolvedValue([runs("o1", "Harbour FC")]);
    for (const id of ["wa-a", "wa-b", "wa-c"]) await handleSettingUpDm(args({ waMessageId: id }));
    expect(queuePlatformDm).toHaveBeenCalledTimes(3);
    dbMock.sentNotification.create.mockRejectedValueOnce(unique());
    expect(await handleSettingUpDm(args({ waMessageId: "wa-a" }))).toEqual({ handled: "setup-dm-duplicate" });
    expect(queuePlatformDm).toHaveBeenCalledTimes(3);
  });

  it("review fix 1a: 15 chatty messages queue 5 replies, not 15; the rest get silence", async () => {
    dbMock.membership.findMany.mockResolvedValue([runs("o1", "Harbour FC")]);
    // The count is what has really been queued so far.
    dbMock.platformJob.count.mockImplementation(async () => queuePlatformDm.mock.calls.length);
    const out = [];
    for (let i = 0; i < 15; i++) out.push(await handleSettingUpDm(args({ waMessageId: `wa-${i}`, text: `message ${i}` })));
    expect(queuePlatformDm).toHaveBeenCalledTimes(5);
    expect(out.slice(0, 5).every((o) => "handled" in o && o.handled === "setup-not-recognised")).toBe(true);
    expect(out.slice(5)).toEqual(Array(10).fill({ ignored: "setup-reply-capped" }));
  });

  it("the cap covers help too: over it, no help is built or queued", async () => {
    dbMock.membership.findMany.mockResolvedValue([runs("o1", "Harbour FC")]);
    repliesSoFar(15, 0);
    expect(await handleSettingUpDm(args({ readHelp: async () => ({ topic: null }), text: "help" }))).toEqual({ ignored: "setup-reply-capped" });
    expect(handleDmHelp).not.toHaveBeenCalled();
    expect(queuePlatformDm).not.toHaveBeenCalled();
  });

  it("more than one club: one reply, pointing at the settings page", async () => {
    dbMock.membership.findMany.mockResolvedValue([runs("o1", "Twin A"), runs("o2", "Twin B")]);
    expect(await handleSettingUpDm(args())).toEqual({ handled: "setup-not-recognised", orgIds: ["o1", "o2"] });
    expect(queuePlatformDm.mock.calls[0][0].text).toBe(en.sj_go_not_recognised_many({ url: SETTINGS }));
  });

  it("the Turkish club's organiser is answered in Turkish", async () => {
    dbMock.membership.findMany.mockResolvedValue([runs("o1", "Kıyı SK", "tr")]);
    await handleSettingUpDm(args());
    expect(queuePlatformDm.mock.calls[0][0].text).toBe(tr.sj_go_not_recognised({ club: "Kıyı SK", url: SETTINGS }));
  });

  it("a help request is answered with the help, delivered on the platform channel, not with 'not recognised'", async () => {
    dbMock.membership.findMany.mockResolvedValue([runs("o1", "Harbour FC")]);
    handleDmHelp.mockResolvedValue({ handled: "dm-help", topic: null, orgId: "o1", audience: "admin" });
    expect(await handleSettingUpDm(args({ readHelp: async () => ({ topic: null }), text: "help" }))).toEqual({
      handled: "dm-help",
      topic: null,
      orgId: "o1",
      audience: "admin",
    });
    expect(handleDmHelp).toHaveBeenCalledWith({ userId: "u-hana", req: { topic: null }, envelopePhone: "447700900971", deliver: "platform" });
    expect(queuePlatformDm).not.toHaveBeenCalled();
  });

  it("the help read (the shared question extractor) is asked only for an owner or admin, and 'not help' is 'not recognised' (2026-10-28)", async () => {
    const readHelp = vi.fn(async () => null);
    dbMock.membership.findMany.mockResolvedValue([]);
    await handleSettingUpDm(args({ readHelp }));
    expect(readHelp).not.toHaveBeenCalled();
    dbMock.membership.findMany.mockResolvedValue([runs("o1", "Harbour FC")]);
    expect(await handleSettingUpDm(args({ readHelp, waMessageId: "wa-3" }))).toEqual({ handled: "setup-not-recognised", orgIds: ["o1"] });
    expect(readHelp).toHaveBeenCalledTimes(1);
    expect(handleDmHelp).not.toHaveBeenCalled();
  });

  it("review fix 5: the claim is released when the reply cannot be queued, so the Pi's retry is answered", async () => {
    dbMock.membership.findMany.mockResolvedValue([runs("o1", "Harbour FC")]);
    queuePlatformDm.mockRejectedValueOnce(new Error("queue down"));
    await expect(handleSettingUpDm(args())).rejects.toThrow("queue down");
    expect(dbMock.sentNotification.deleteMany).toHaveBeenCalledWith({ where: { key: "setup-dm-msg:wa-2" } });
    // The retry of the SAME message now goes through.
    expect(await handleSettingUpDm(args())).toEqual({ handled: "setup-not-recognised", orgIds: ["o1"] });
  });

  it("review fix 5: so is it when the help throws", async () => {
    dbMock.membership.findMany.mockResolvedValue([runs("o1", "Harbour FC")]);
    handleDmHelp.mockRejectedValue(new Error("database down"));
    await expect(handleSettingUpDm(args({ readHelp: async () => ({ topic: null }), text: "help" }))).rejects.toThrow("database down");
    expect(dbMock.sentNotification.deleteMany).toHaveBeenCalledWith({ where: { key: "setup-dm-msg:wa-2" } });
  });

  it("a database error on the claim is not read as a duplicate", async () => {
    dbMock.membership.findMany.mockResolvedValue([runs("o1", "Harbour FC")]);
    dbMock.sentNotification.create.mockRejectedValue(new Error("connection terminated"));
    await expect(handleSettingUpDm(args())).rejects.toThrow("connection terminated");
    expect(queuePlatformDm).not.toHaveBeenCalled();
  });

  it("a number the platform channel refuses gets silence, and the claim is kept", async () => {
    dbMock.membership.findMany.mockResolvedValue([runs("o1", "Harbour FC")]);
    queuePlatformDm.mockRejectedValue(new platform.PlatformDmRefused("no MatchTime user has this number"));
    expect(await handleSettingUpDm(args())).toEqual({ handled: "setup-not-recognised", orgIds: ["o1"] });
    expect(dbMock.sentNotification.deleteMany).not.toHaveBeenCalled();
  });
});
