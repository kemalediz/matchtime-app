/**
 * The web app's "I'm in" toast says what the write did (2026-10-16).
 *
 * Same bug class as the FNF tentative follow-up DM: `AttendButton` showed
 * "You're in! See you at the match" for every successful tap, while
 * `registerAttendance` can put the player on the BENCH (squad full, or an
 * organiser-pick club holding the place for the organisers). "You're in"
 * is said only of a CONFIRMED row.
 */
import { describe, it, expect } from "vitest";
import { t } from "../i18n/t";

describe("web_attend_toast", () => {
  it("CONFIRMED: you're in", () => {
    expect(t("en").web_attend_toast({ status: "CONFIRMED", organiser: false })).toContain("You're in");
    expect(t("en").web_attend_toast({ status: "CONFIRMED", organiser: true })).toContain("You're in");
    expect(t("tr").web_attend_toast({ status: "CONFIRMED", organiser: true }).toLocaleLowerCase("tr")).toContain("kadrodasın");
  });

  it("BENCH in an organiser-pick club: on the bench, the organisers pick, never 'you're in'", () => {
    const en = t("en").web_attend_toast({ status: "BENCH", organiser: true });
    expect(en).not.toMatch(/you're in/i);
    expect(en).toContain("bench");
    expect(en).toContain("organisers pick who plays");
    expect(en).not.toMatch(/full/i);
    const tr = t("tr").web_attend_toast({ status: "BENCH", organiser: true });
    expect(tr).not.toContain("kadrodasın");
    expect(tr).toContain("organizatörler");
  });

  it("BENCH in a first-come club: the squad is full, on the bench", () => {
    const en = t("en").web_attend_toast({ status: "BENCH", organiser: false });
    expect(en).not.toMatch(/you're in/i);
    expect(en).toContain("full");
    expect(en).toContain("bench");
    const tr = t("tr").web_attend_toast({ status: "BENCH", organiser: false });
    expect(tr).not.toContain("kadrodasın");
    expect(tr).toMatch(/yede[kğ]/);
  });
});
