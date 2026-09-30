/**
 * The Pi's silence rails (self-join slice 1): a silent group is never
 * monitored, whatever tries to add it, and the legacy "@MatchTime setup"
 * trigger can be switched off by the server.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  addAdminGroup,
  isAdminGroup,
  removeAdminGroup,
  setAdminGroups,
  addMonitoredGroup,
  addSilentGroup,
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

  it("slice 6: a group the server just called silent is silent at once, until the next refresh says otherwise", () => {
    setMonitoredGroups([SUTTON]);
    addSilentGroup(PENDING);
    expect(isSilentGroup(PENDING)).toBe(true);
    addMonitoredGroup(PENDING);
    expect(isMonitoredGroup(PENDING)).toBe(false);
    expect(isMonitoredGroup(SUTTON)).toBe(true);
  });

  it("slice 6: a LIVE (monitored) group is never silenced by a stray answer", () => {
    setMonitoredGroups([SUTTON]);
    addSilentGroup(SUTTON);
    expect(isSilentGroup(SUTTON)).toBe(false);
    expect(isMonitoredGroup(SUTTON)).toBe(true);
  });
});

describe("admin groups on the Pi (slice 2a)", () => {
  const HQ = "hq@g.us";
  beforeEach(() => {
    setAdminGroups([]);
    setSilentGroups([]);
    setMonitoredGroups([]);
    setOnboardingGroups([]);
  });

  it("an admin group is never monitored, onboarding or silent, whatever the other lists say", () => {
    setAdminGroups([{ groupId: HQ, orgId: "org-fnf" }]);
    setSilentGroups([HQ]);
    setMonitoredGroups([SUTTON, HQ]);
    setOnboardingGroups([HQ]);
    addSilentGroup(HQ);
    addMonitoredGroup(HQ);
    addOnboardingGroup(HQ);
    expect(isAdminGroup(HQ)).toBe(true);
    expect(isMonitoredGroup(HQ)).toBe(false);
    expect(isSilentGroup(HQ)).toBe(false);
    expect(_test_groupSets().onboarding).toEqual([]);
    expect(isMonitoredGroup(SUTTON)).toBe(true);
  });

  it("linking a silent candidate makes it an admin group at once", () => {
    setSilentGroups([HQ]);
    addAdminGroup(HQ, "org-fnf");
    expect(isAdminGroup(HQ)).toBe(true);
    expect(isSilentGroup(HQ)).toBe(false);
  });

  it("a live club's group can never be turned into an admin group by an answer", () => {
    setMonitoredGroups([SUTTON]);
    addAdminGroup(SUTTON, "org-x");
    expect(isAdminGroup(SUTTON)).toBe(false);
    expect(isMonitoredGroup(SUTTON)).toBe(true);
  });

  it("removal forgets it", () => {
    setAdminGroups([{ groupId: HQ, orgId: "org-fnf" }]);
    removeAdminGroup(HQ);
    expect(isAdminGroup(HQ)).toBe(false);
  });
});
