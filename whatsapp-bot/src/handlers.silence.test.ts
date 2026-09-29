/**
 * The Pi's silence rails (self-join slice 1): a silent group is never
 * monitored, whatever tries to add it, and the legacy "@MatchTime setup"
 * trigger can be switched off by the server.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  addMonitoredGroup,
  addOnboardingGroup,
  isLegacySetupTriggerEnabled,
  isMonitoredGroup,
  isSilentGroup,
  setLegacySetupTrigger,
  setMonitoredGroups,
  setOnboardingGroups,
  setSilentGroups,
  _test_groupSets,
} from "./handlers.js";

const SUTTON = "sutton@g.us";
const PENDING = "pending@g.us";

describe("silent groups on the Pi", () => {
  beforeEach(() => {
    setSilentGroups([]);
    setMonitoredGroups([]);
    setOnboardingGroups([]);
    setLegacySetupTrigger(true);
  });

  it("Sutton FC is monitored exactly as before when nothing is silent", () => {
    setMonitoredGroups([SUTTON]);
    expect(isMonitoredGroup(SUTTON)).toBe(true);
    expect(isSilentGroup(SUTTON)).toBe(false);
  });

  it("a silent group is not monitored even if the monitored list names it", () => {
    setSilentGroups([PENDING]);
    setMonitoredGroups([SUTTON, PENDING]);
    expect(isMonitoredGroup(SUTTON)).toBe(true);
    expect(isMonitoredGroup(PENDING)).toBe(false);
  });

  it("the setup trigger and the bot-added path cannot add a silent group", () => {
    setSilentGroups([PENDING]);
    addMonitoredGroup(PENDING);
    addOnboardingGroup(PENDING);
    expect(isMonitoredGroup(PENDING)).toBe(false);
    expect(_test_groupSets().onboarding).not.toContain(PENDING);
  });

  it("a group that stops being silent (approved later) can be monitored again", () => {
    setSilentGroups([PENDING]);
    setMonitoredGroups([PENDING]);
    expect(isMonitoredGroup(PENDING)).toBe(false);
    setSilentGroups([]);
    setMonitoredGroups([PENDING]);
    expect(isMonitoredGroup(PENDING)).toBe(true);
  });

  it("the legacy setup trigger defaults ON (an older server) and follows the server", () => {
    expect(isLegacySetupTriggerEnabled()).toBe(true);
    setLegacySetupTrigger(false);
    expect(isLegacySetupTriggerEnabled()).toBe(false);
  });
});
