/**
 * "Approved but setting up" (go-live plan 2.1, slice S1): the pure rules.
 * No database, no network, no model.
 */
import { describe, expect, it } from "vitest";
import {
  BOT_ON_OR_SETTING_UP_WHERE,
  LIVE_STAGE_WHERE,
  SETTING_UP_CLUB_WHERE,
  SETUP_STAGES,
  SETUP_STAGE_SELECT,
  isClubSettingUp,
  isSetupHoldEnabled,
  settingUpClubFields,
  settingUpOnly,
} from "../club-setup-rules";

const live = { approvalStatus: "approved", setupStage: "live" };
const held = { approvalStatus: "approved", setupStage: "setting-up" };

describe("setup stages", () => {
  it("has exactly the two stages the CHECK constraint allows", () => {
    expect([...SETUP_STAGES]).toEqual(["live", "setting-up"]);
  });

  it("the Prisma fragment for a setting-up club is approved AND setting-up", () => {
    expect(SETTING_UP_CLUB_WHERE).toEqual({ approvalStatus: "approved", setupStage: "setting-up" });
  });

  it("the fragment for a club that is not held is one field", () => {
    expect(LIVE_STAGE_WHERE).toEqual({ setupStage: "live" });
  });

  it("the sweep's fragment: the bot is on, or the club is setting up", () => {
    expect(BOT_ON_OR_SETTING_UP_WHERE).toEqual({
      OR: [{ whatsappBotEnabled: true }, { approvalStatus: "approved", setupStage: "setting-up" }],
    });
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
