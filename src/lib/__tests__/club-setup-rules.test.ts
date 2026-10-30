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
  WENT_LIVE_CLUB_WHERE,
  STILL_READING_WINDOW_MS,
  isSetupLearningFinal,
  liveByOwner,
  liveByUser,
  readingBlocksGoLive,
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

describe("who took a club live", () => {
  it("a site admin is the bare user id", () => expect(liveByUser("u-hana")).toBe("u-hana"));
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

  it("the window is two hours from approval", () => {
    expect(STILL_READING_WINDOW_MS).toBe(2 * 60 * 60 * 1000);
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

describe("clubs that have been through the hold", () => {
  it("WENT_LIVE_CLUB_WHERE is approved, live, and stamped: with no time limit (review fix 6)", () => {
    expect(WENT_LIVE_CLUB_WHERE).toEqual({ approvalStatus: "approved", setupStage: "live", liveAt: { not: null } });
  });

  it("it can never match a club that was not held: every club that exists today has no stamp", () => {
    expect(hasGoneLive({ liveAt: null })).toBe(false);
    expect(NEVER_HELD_WHERE).toEqual({ liveAt: null });
  });
});
