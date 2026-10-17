/**
 * CLUB_LIMIT_EXEMPT_ORG_IDS (2026-10-16): one env var exempts listed clubs
 * from the new-club DM cap. Unset or empty changes nothing. It no longer
 * lifts the admin-group posting hours: those are the club's quiet hours.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLUB_LIMIT_EXEMPT_ENV, isClubLimitExempt, parseClubLimitExemptIds } from "../club-limit-exempt";
import { newClubDmCap } from "../club-decision-rules";
import { isAdminGroupPostHour } from "../admin-channel-rules";

afterEach(() => vi.unstubAllEnvs());

const NOW = new Date("2026-10-16T12:00:00Z");
const NEW_CLUB = { id: "org-new", approvedAt: new Date("2026-10-10T12:00:00Z") };
const NIGHT = new Date("2026-09-30T22:30:00Z"); // 23:30 BST
const NOON = new Date("2026-09-30T11:00:00Z");

describe("parseClubLimitExemptIds", () => {
  it("splits on commas and whitespace, dropping blanks", () => {
    expect([...parseClubLimitExemptIds("a, b,,c\n d\te ")]).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("unset or empty means nobody", () => {
    expect(parseClubLimitExemptIds(undefined).size).toBe(0);
    expect(parseClubLimitExemptIds(null).size).toBe(0);
    expect(parseClubLimitExemptIds("").size).toBe(0);
    expect(parseClubLimitExemptIds(" , ").size).toBe(0);
  });
});

describe("isClubLimitExempt", () => {
  it("false when the env var is empty", () => {
    vi.stubEnv(CLUB_LIMIT_EXEMPT_ENV, "");
    expect(isClubLimitExempt("org-new")).toBe(false);
  });
  it("true only for a listed org, never for a missing id", () => {
    vi.stubEnv(CLUB_LIMIT_EXEMPT_ENV, "org-x org-new");
    expect(isClubLimitExempt("org-new")).toBe(true);
    expect(isClubLimitExempt("org-other")).toBe(false);
    expect(isClubLimitExempt(undefined)).toBe(false);
    expect(isClubLimitExempt(null)).toBe(false);
  });
});

describe("newClubDmCap with the exemption", () => {
  it("unexempt new club keeps its cap of 20", () => {
    vi.stubEnv(CLUB_LIMIT_EXEMPT_ENV, "org-other");
    expect(newClubDmCap(NEW_CLUB, NOW)).toBe(20);
  });
  it("exempt new club has no cap", () => {
    vi.stubEnv(CLUB_LIMIT_EXEMPT_ENV, "org-new");
    expect(newClubDmCap(NEW_CLUB, NOW)).toBeNull();
  });
});

describe("the exemption no longer touches the admin-group hours (2026-10-16)", () => {
  it("a listed club still waits overnight with its default quiet hours: the hours are the club's setting now", () => {
    vi.stubEnv(CLUB_LIMIT_EXEMPT_ENV, "org-new");
    expect(isAdminGroupPostHour(NIGHT)).toBe(false);
    expect(isAdminGroupPostHour(NOON)).toBe(true);
  });
  it("only the club's quiet hours set to off lift the hold", () => {
    vi.stubEnv(CLUB_LIMIT_EXEMPT_ENV, "");
    expect(isAdminGroupPostHour(NIGHT, { enabled: false, from: "23:00", to: "09:00" })).toBe(true);
  });
});
