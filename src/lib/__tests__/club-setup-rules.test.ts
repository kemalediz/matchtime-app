/**
 * "Approved but setting up" (go-live plan 2.1, slice S1): the pure rules.
 * No database, no network, no model.
 */
import { describe, expect, it } from "vitest";
import {
  IN_LIVE_STAGE_CLUB_WHERE,
  LIVE_STAGE_WHERE,
  NEVER_HELD_WHERE,
  SETUP_READABLE_CLUB_WHERE,
  SETTING_UP_CLUB_WHERE,
  SETUP_STAGE_SELECT,
  hasGoneLive,
  isClubSettingUp,
  isSetupHoldEnabled,
  preferLiveClubs,
  settingUpClubFields,
  settingUpOnly,
  GO_ALREADY_LIVE_WINDOW_MS,
  STILL_READING_WINDOW_MS,
  isGoCommand,
  isSetupLearningFinal,
  liveByOwner,
  liveByUser,
  liveByWhatsapp,
  readingBlocksGoLive,
  wentLiveSinceWhere,
} from "../club-setup-rules";

const live = { approvalStatus: "approved", setupStage: "live" };
const held = { approvalStatus: "approved", setupStage: "setting-up" };

describe("setup stages", () => {
  it("the Prisma fragment for a setting-up club is approved AND setting-up", () => {
    expect(SETTING_UP_CLUB_WHERE).toEqual({ approvalStatus: "approved", setupStage: "setting-up" });
  });

  it("the fragment for a club that is not held is one field", () => {
    expect(LIVE_STAGE_WHERE).toEqual({ setupStage: "live" });
  });

  it("the sweep's fragment: the bot is on AND the club was never held, or the club is setting up", () => {
    expect(SETUP_READABLE_CLUB_WHERE).toEqual({
      OR: [{ whatsappBotEnabled: true, liveAt: null }, { approvalStatus: "approved", setupStage: "setting-up" }],
    });
  });

  it("'never held' is a NULL go-live stamp, which every existing club has", () => {
    expect(NEVER_HELD_WHERE).toEqual({ liveAt: null });
  });

  it("the membership fragment for the DM path: the member's club is not held", () => {
    expect(IN_LIVE_STAGE_CLUB_WHERE).toEqual({ org: { setupStage: "live" } });
  });

  it("the select other modules use carries both columns the decision needs", () => {
    expect(SETUP_STAGE_SELECT).toEqual({ approvalStatus: true, setupStage: true });
  });

  it("the fields a held approval writes are the stage and nothing else", () => {
    expect(settingUpClubFields()).toEqual({ setupStage: "setting-up" });
  });
});

describe("isClubSettingUp", () => {
  it("an approved club in the setting-up stage is", () => {
    expect(isClubSettingUp(held)).toBe(true);
  });

  it("every existing club (stage live by the column default) is not", () => {
    expect(isClubSettingUp(live)).toBe(false);
  });

  it("a club that is not approved is never 'setting up', whatever its stage says", () => {
    for (const approvalStatus of ["draft", "pending", "rejected", "suspended"]) {
      expect(isClubSettingUp({ approvalStatus, setupStage: "setting-up" })).toBe(false);
    }
  });

  it("a missing or unknown stage is not setting up", () => {
    expect(isClubSettingUp({ approvalStatus: "approved", setupStage: undefined })).toBe(false);
    expect(isClubSettingUp({ approvalStatus: "approved", setupStage: null })).toBe(false);
    expect(isClubSettingUp({ approvalStatus: "approved", setupStage: "maybe" })).toBe(false);
  });
});

describe("settingUpOnly: is every club MatchTime serves for this sender still setting up?", () => {
  it("no clubs at all: no", () => {
    expect(settingUpOnly([])).toBe(false);
  });

  it("one setting-up club: yes", () => {
    expect(settingUpOnly([held])).toBe(true);
  });

  it("a live club beside it: no, the sender is handled exactly as today", () => {
    expect(settingUpOnly([held, live])).toBe(false);
  });

  it("only live clubs: no", () => {
    expect(settingUpOnly([live, live])).toBe(false);
  });
});

describe("SETUP_HOLD_ENABLED", () => {
  it("is OFF unless explicitly switched on", () => {
    expect(isSetupHoldEnabled({})).toBe(false);
    expect(isSetupHoldEnabled({ SETUP_HOLD_ENABLED: "" })).toBe(false);
    expect(isSetupHoldEnabled({ SETUP_HOLD_ENABLED: "0" })).toBe(false);
    expect(isSetupHoldEnabled({ SETUP_HOLD_ENABLED: "false" })).toBe(false);
    for (const v of ["1", "true", "on", "yes", " TRUE "]) {
      expect(isSetupHoldEnabled({ SETUP_HOLD_ENABLED: v })).toBe(true);
    }
  });
});

describe("hasGoneLive: has this club been through the hold and come out?", () => {
  it("a club with a go-live stamp has", () => {
    expect(hasGoneLive({ liveAt: new Date("2026-10-12T10:05:00Z") })).toBe(true);
  });

  it("every existing club (no stamp) has not, nor has a row read without the column", () => {
    expect(hasGoneLive({ liveAt: null })).toBe(false);
    expect(hasGoneLive({})).toBe(false);
  });
});

describe("preferLiveClubs: a setting-up club does not exist for club selection, unless it is all there is", () => {
  const row = (id: string, org: typeof live) => ({ id, org });

  it("with no setting-up club the list is returned as it was (the same rows, the same order)", () => {
    const rows = [row("a", live), row("b", live)];
    expect(preferLiveClubs(rows, (r) => r.org)).toEqual(rows);
  });

  it("a setting-up club is dropped when the person has a live club too", () => {
    expect(preferLiveClubs([row("held", held), row("sutton", live)], (r) => r.org).map((r) => r.id)).toEqual(["sutton"]);
  });

  it("someone whose every club is setting up keeps them (the help request is theirs)", () => {
    expect(preferLiveClubs([row("held", held)], (r) => r.org).map((r) => r.id)).toEqual(["held"]);
  });

  it("nothing in, nothing out", () => {
    expect(preferLiveClubs([], (r: { org: typeof live }) => r.org)).toEqual([]);
  });
});

describe("isGoCommand: the text gate of the GO handler (slice S4)", () => {
  it.each(["GO", "go", "Go", "GO LIVE", "go live", "Go  Live", "BAŞLA", "başla", "Başla", "BASLA", "basla", " go ", "GO.", "go!", "başla!", "GO LIVE."])(
    "%j is GO",
    (text) => expect(isGoCommand(text)).toBe(true),
  );

  it.each([
    "go on then",
    "GO now",
    "let's go",
    "go?",
    "go!!",
    "go..",
    "go, please",
    "golive",
    "g o",
    "başlat",
    "basla artik",
    "yes",
    "in",
    "help",
    "",
    "   ",
    "GO\nlive now please",
    "@Match Time go",
  ])("%j is NOT GO", (text) => expect(isGoCommand(text)).toBe(false));

  it("anything that is not a string is not GO", () => {
    expect(isGoCommand(null)).toBe(false);
    expect(isGoCommand(undefined)).toBe(false);
    expect(isGoCommand(42 as unknown as string)).toBe(false);
  });
});

describe("who took a club live", () => {
  it("a site admin is the bare user id", () => expect(liveByUser("u-hana")).toBe("u-hana"));
  it("a WhatsApp GO is whatsapp:<digits>", () => {
    expect(liveByWhatsapp("+44 7700 900971")).toBe("whatsapp:447700900971");
    expect(liveByWhatsapp("447700900971")).toBe("whatsapp:447700900971");
  });
  it("the platform owner is owner:<id>", () => expect(liveByOwner("u-kemal")).toBe("owner:u-kemal"));
});

describe("readingBlocksGoLive: GO before the reading has finished (owner decision 4)", () => {
  const NOW = new Date("2026-10-12T12:00:00Z");
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const base = { learningEnabled: true, readingExpected: true, approvedAt: ago(10 * 60_000), now: NOW };

  it("the final statuses are applied, nothing, skipped and failed", () => {
    for (const s of ["applied", "nothing", "skipped", "failed"]) expect(isSetupLearningFinal(s)).toBe(true);
    for (const s of ["running", "deferred", "", null, undefined]) expect(isSetupLearningFinal(s)).toBe(false);
  });

  it("the window is two hours from approval; the already-live window is ten minutes", () => {
    expect(STILL_READING_WINDOW_MS).toBe(2 * 60 * 60 * 1000);
    expect(GO_ALREADY_LIVE_WINDOW_MS).toBe(10 * 60 * 1000);
  });

  it.each(["running", "deferred"])("a %s reading blocks inside the window", (status) =>
    expect(readingBlocksGoLive({ ...base, learningStatus: status })).toBe(true),
  );

  it.each(["applied", "nothing", "skipped", "failed"])("a %s reading never blocks", (status) =>
    expect(readingBlocksGoLive({ ...base, learningStatus: status })).toBe(false),
  );

  it("no row yet blocks only when a reading is expected", () => {
    expect(readingBlocksGoLive({ ...base, learningStatus: null })).toBe(true);
    expect(readingBlocksGoLive({ ...base, learningStatus: null, readingExpected: false })).toBe(false);
  });

  it("nothing blocks once two hours have passed since approval", () => {
    expect(readingBlocksGoLive({ ...base, learningStatus: "running", approvedAt: ago(STILL_READING_WINDOW_MS) })).toBe(false);
    expect(readingBlocksGoLive({ ...base, learningStatus: null, approvedAt: ago(3 * 60 * 60_000) })).toBe(false);
  });

  it("nothing blocks with the learning flag off, whatever the row says", () => {
    expect(readingBlocksGoLive({ ...base, learningEnabled: false, learningStatus: "running" })).toBe(false);
    expect(readingBlocksGoLive({ ...base, learningEnabled: false, learningStatus: null })).toBe(false);
  });

  it("a club with no approval time is not blocked (nothing to measure two hours from)", () => {
    expect(readingBlocksGoLive({ ...base, learningStatus: "running", approvedAt: null })).toBe(false);
  });
});

describe("wentLiveSinceWhere", () => {
  it("is approved, live, and stamped at or after the instant", () => {
    const since = new Date("2026-10-12T11:50:00Z");
    expect(wentLiveSinceWhere(since)).toEqual({ approvalStatus: "approved", setupStage: "live", liveAt: { gte: since } });
  });
});
