/**
 * The match context header's labels (Kemal, 2026-10-18): the payments
 * page and the team management page say which match they are about.
 */
import { describe, it, expect } from "vitest";
import { matchContext } from "../match-context";

/** Tue 22 Sept 2026, 21:30 London (BST, UTC+1). */
const TUE = new Date("2026-09-22T20:30:00.000Z");

const base = {
  date: TUE,
  status: "COMPLETED",
  redScore: null,
  yellowScore: null,
  teamLabels: ["Red", "Yellow"] as [string, string],
};

describe("matchContext", () => {
  it("writes the date and kickoff in London time, English", () => {
    const c = matchContext({ ...base, lang: "en" });
    expect(c.dateLabel).toBe("Tue 22 Sep");
    expect(c.timeLabel).toBe("21:30");
    expect(c.kickoffLabel).toBe("Kickoff 21:30");
    expect(c.backLabel).toBe("Back to match");
  });

  it("writes them the Turkish way", () => {
    const c = matchContext({ ...base, lang: "tr" });
    expect(c.dateLabel).toBe("22 Eylül Salı");
    expect(c.timeLabel).toBe("21:30");
    expect(c.kickoffLabel).toBe("Başlama 21:30");
    expect(c.backLabel).toBe("Maça dön");
  });

  it("accepts the date as JSON (the client page reads it from the API)", () => {
    const c = matchContext({ ...base, date: TUE.toISOString(), lang: "en" });
    expect(c.dateLabel).toBe("Tue 22 Sep");
    expect(c.timeLabel).toBe("21:30");
  });

  it("labels every status in both languages, with its own colour", () => {
    const en = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED", "COMPLETED", "CANCELLED"].map(
      (status) => matchContext({ ...base, status, lang: "en" }).statusLabel,
    );
    expect(en).toEqual(["Upcoming", "Teams made", "Teams published", "Played", "Cancelled"]);
    const tr = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED", "COMPLETED", "CANCELLED"].map(
      (status) => matchContext({ ...base, status, lang: "tr" }).statusLabel,
    );
    expect(tr).toEqual(["Yaklaşan", "Takımlar kuruldu", "Takımlar duyuruldu", "Oynandı", "İptal edildi"]);
    expect(matchContext({ ...base, status: "COMPLETED", lang: "en" }).statusTone).toContain("green");
    expect(matchContext({ ...base, status: "CANCELLED", lang: "en" }).statusTone).toContain("red");
  });

  it("an unknown status still reads as words, never the raw enum", () => {
    expect(matchContext({ ...base, status: "SOME_NEW_STATE", lang: "en" }).statusLabel).toBe("Some new state");
  });

  it("no score until both sides have one", () => {
    expect(matchContext({ ...base, lang: "en" }).score).toBeNull();
    expect(matchContext({ ...base, redScore: 3, lang: "en" }).score).toBeNull();
  });

  it("the score carries the club's team labels, 0 included", () => {
    const c = matchContext({ ...base, redScore: 0, yellowScore: 2, teamLabels: ["Bibs", "Shirts"], lang: "en" });
    expect(c.score).toEqual({ redLabel: "Bibs", red: 0, yellowLabel: "Shirts", yellow: 2 });
  });

  it("no new copy carries an em or en dash", () => {
    for (const lang of ["en", "tr"]) {
      for (const status of ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED", "COMPLETED", "CANCELLED"]) {
        const c = matchContext({ ...base, status, lang });
        for (const s of [c.statusLabel, c.kickoffLabel, c.backLabel, c.dateLabel]) expect(s).not.toMatch(/[–—]/);
      }
    }
  });
});
