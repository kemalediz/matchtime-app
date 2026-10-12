/**
 * The organiser's one DM when the MatchTime team took their club live for
 * them (src/lib/club-setup-owner-live.ts), with everything round it
 * mocked. No network, no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  platformJob: { findFirst: vi.fn() },
  clubConnect: { findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("../db", () => ({ db: dbMock }));

const buildAdminLink = vi.hoisted(() => vi.fn());
vi.mock("../admin-link", () => ({ buildAdminLink, appUrl: (p: string) => `https://matchtime.test${p}` }));

const jobs = vi.hoisted(() => {
  class PlatformDmRefused extends Error {
    constructor(
      readonly reason: string,
      readonly code: string = "number-not-known",
    ) {
      super(reason);
    }
  }
  return { PlatformDmRefused, queuePlatformDm: vi.fn() };
});
vi.mock("../platform-jobs", () => jobs);

import {
  SETUP_OWNER_LIVE_DM_PURPOSE,
  composeOwnerLiveDm,
  setupOwnerLiveRefId,
  tellOrganiserOwnerWentLive,
} from "../club-setup-owner-live";

const NOON = new Date("2026-07-14T11:00:00Z"); // 12:00 London
const NIGHT = new Date("2026-07-14T23:10:00Z"); // 00:10 London
const NINE = new Date("2026-07-15T08:00:00Z"); // 09:00 London
const PHONE = "447700900971";
const NOTE = "Your first 2 months are free. After that it is £9.99 a month at most.\n\nA tip: add 30p to each match fee.";
const LIVE = {
  outcome: "went-live" as const,
  orgId: "org-harbour",
  club: "Harbour FC",
  group: "Harbour Tuesday 6s",
  language: "en",
  liveAt: NOON,
  liveBy: "owner:u-kemal",
  hello: "Hi all",
  purgedJobs: 0,
  quietedMatches: 0,
  freePeriodStarted: true,
  freePeriodNote: NOTE,
};
const SIGNED = "https://matchtime.test/r/signed";

let logs: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  dbMock.platformJob.findFirst.mockResolvedValue(null);
  dbMock.clubConnect.findFirst.mockResolvedValue({ userId: "u-hana", phone: PHONE });
  buildAdminLink.mockResolvedValue(SIGNED);
  jobs.queuePlatformDm.mockResolvedValue({ id: "pj1" });
  logs = [];
  for (const level of ["log", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  }
});

describe("composeOwnerLiveDm: the words", () => {
  it("English: who started it and that it is introducing itself, the free period note AS GIVEN, the settings link", () => {
    expect(composeOwnerLiveDm({ lang: "en", group: "Harbour Tuesday 6s", freePeriodNote: NOTE, settingsUrl: SIGNED })).toBe(
      `The MatchTime team has started MatchTime in "Harbour Tuesday 6s" for you, so you don't need to reply GO. It introduces itself in the group, which can take a few minutes to appear.` +
        `\n\n${NOTE}` +
        `\n\n⚙️ *Check or change how your group runs:*\n${SIGNED}`,
    );
  });

  it("Turkish, with BAŞLA", () => {
    expect(composeOwnerLiveDm({ lang: "tr", group: "Kıyı Salı Maçı", freePeriodNote: null, settingsUrl: SIGNED })).toBe(
      `MatchTime ekibi MatchTime'ı "Kıyı Salı Maçı" grubunda sizin için başlattı, BAŞLA yazmanıza gerek kalmadı. MatchTime grupta kendini tanıtıyor, mesajın görünmesi birkaç dakika sürebilir.` +
        `\n\n⚙️ *Grubunuzun nasıl işlediğini kontrol edin ya da değiştirin:*\n${SIGNED}`,
    );
  });

  it("no free period started (billing off, the Free plan, one already had): no free period block at all", () => {
    const text = composeOwnerLiveDm({ lang: "en", group: "G", freePeriodNote: null, settingsUrl: SIGNED });
    expect(text.split("\n\n")).toHaveLength(2);
    expect(text).not.toMatch(/free/i);
  });

  it("no em or en dash, in either language", () => {
    for (const lang of ["en", "tr"]) {
      expect(composeOwnerLiveDm({ lang, group: "G", freePeriodNote: null, settingsUrl: "u" })).not.toMatch(/[–—]/);
    }
  });
});

describe("tellOrganiserOwnerWentLive", () => {
  it("one DM to the organiser who connected the club (the setup DM's recipient), signed-in settings link, at once in the daytime", async () => {
    expect(await tellOrganiserOwnerWentLive(LIVE, NOON)).toBe("queued");
    expect(dbMock.clubConnect.findFirst).toHaveBeenCalledWith({
      where: { orgId: "org-harbour", status: "closed", linkedAt: { not: null } },
      orderBy: { linkedAt: "desc" },
      select: { userId: true, phone: true },
    });
    expect(buildAdminLink).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-hana", orgId: "org-harbour", nextPath: "/admin/settings" }));
    expect(jobs.queuePlatformDm).toHaveBeenCalledTimes(1);
    expect(jobs.queuePlatformDm).toHaveBeenCalledWith({
      phone: PHONE,
      text: composeOwnerLiveDm({ lang: "en", group: "Harbour Tuesday 6s", freePeriodNote: NOTE, settingsUrl: SIGNED }),
      purpose: SETUP_OWNER_LIVE_DM_PURPOSE,
      refId: setupOwnerLiveRefId("org-harbour"),
      sendAfter: null,
    });
    expect([SETUP_OWNER_LIVE_DM_PURPOSE, setupOwnerLiveRefId("org-harbour")]).toEqual(["setup-owner-live", "org-harbour:setup-owner-live"]);
  });

  it("the free period sentence and fee tip are the writer's own note, word for word", async () => {
    await tellOrganiserOwnerWentLive(LIVE, NOON);
    expect(jobs.queuePlatformDm.mock.calls[0][0].text).toContain(`\n\n${NOTE}\n\n`);
  });

  it("at night it waits for 09:00 London: nobody asked for this message", async () => {
    await tellOrganiserOwnerWentLive(LIVE, NIGHT);
    expect(jobs.queuePlatformDm.mock.calls[0][0].sendAfter).toEqual(NINE);
  });

  it("ONCE per club: a job with this purpose and the club's refId already there, and nothing more is queued", async () => {
    dbMock.platformJob.findFirst.mockResolvedValue({ id: "pj0" });
    expect(await tellOrganiserOwnerWentLive(LIVE, NOON)).toBe("already");
    expect(dbMock.platformJob.findFirst).toHaveBeenCalledWith({
      where: { purpose: "setup-owner-live", refId: "org-harbour:setup-owner-live" },
      select: { id: true },
    });
    expect(jobs.queuePlatformDm).not.toHaveBeenCalled();
  });

  it("the club's language decides the words", async () => {
    await tellOrganiserOwnerWentLive({ ...LIVE, language: "tr", freePeriodNote: null }, NOON);
    expect(jobs.queuePlatformDm.mock.calls[0][0].text).toContain("MatchTime ekibi");
  });

  it("no organiser on record: nobody is told, and it says so", async () => {
    dbMock.clubConnect.findFirst.mockResolvedValue(null);
    expect(await tellOrganiserOwnerWentLive(LIVE, NOON)).toBe("no-organiser");
    expect(jobs.queuePlatformDm).not.toHaveBeenCalled();
  });

  it("a signed-in link that cannot be made: the plain address goes instead", async () => {
    buildAdminLink.mockRejectedValue(new Error("no secret"));
    expect(await tellOrganiserOwnerWentLive(LIVE, NOON)).toBe("queued");
    expect(jobs.queuePlatformDm.mock.calls[0][0].text).toContain("https://matchtime.test/admin/settings");
  });

  it("NEVER THROWS: the club is live whatever happens here", async () => {
    jobs.queuePlatformDm.mockRejectedValue(new jobs.PlatformDmRefused(`no MatchTime user has ${PHONE}`, "number-not-known"));
    expect(await tellOrganiserOwnerWentLive(LIVE, NOON)).toBe("refused");
    jobs.queuePlatformDm.mockRejectedValue(new Error(`database down for ${PHONE}`));
    expect(await tellOrganiserOwnerWentLive(LIVE, NOON)).toBe("failed");
    dbMock.platformJob.findFirst.mockRejectedValue(new Error("database down"));
    expect(await tellOrganiserOwnerWentLive(LIVE, NOON)).toBe("failed");
  });

  it("LOGS carry the club's id and codes only: never a name, a number, the text or a link", async () => {
    await tellOrganiserOwnerWentLive(LIVE, NOON);
    jobs.queuePlatformDm.mockRejectedValue(new jobs.PlatformDmRefused(`no MatchTime user has ${PHONE}`, "number-not-known"));
    await tellOrganiserOwnerWentLive(LIVE, NOON);
    jobs.queuePlatformDm.mockRejectedValue(new Error(`database down for ${PHONE}`));
    await tellOrganiserOwnerWentLive(LIVE, NOON);
    const all = logs.join("\n");
    expect(all).toContain("org-harbour");
    expect(all).toContain("number-not-known");
    for (const secret of ["Harbour FC", "Harbour Tuesday 6s", PHONE, "matchtime.test", "MatchTime team has started", "free"]) {
      expect(all).not.toContain(secret);
    }
  });
});
