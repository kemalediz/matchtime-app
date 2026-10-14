/**
 * A club's own graphics template (2026-10-14): the layout stored with its
 * background, when the template is used rather than the default design,
 * how a name is fitted to its row, and the date, time and reserves lines
 * in the template's style. Pure: no renderer, no database.
 */
import { describe, expect, it } from "vitest";
import {
  brandSubtitleLabel,
  fitTemplateName,
  graphicDesign,
  parseClubGraphicsLayout,
  reservesLine,
  templateChoice,
  templateDateLabel,
  templateTimeLabel,
  type ClubGraphicsLayout,
} from "../club-graphics-layout";

const LAYOUT: ClubGraphicsLayout = {
  version: 1,
  width: 941,
  height: 1672,
  rows: [543, 606, 668.5, 729.5, 791.5, 854.5, 919, 984, 1048],
  capHeight: 29,
  name: { colour: "#ffffff", maxFontSize: 42, minFontSize: 26 },
  columns: [
    { nameX: 200, maxWidth: 232, iconCentreX: 142, badgeColour: "#0b0b0d" },
    { nameX: 618, maxWidth: 222, iconCentreX: 562, badgeColour: "#ffffff" },
  ],
  date: { x: 764, centreY: 232.5, fontSize: 20, colour: "#ffffff", maxWidth: 98 },
  time: { x: 765, centreY: 270, fontSize: 20, colour: "#ffffff", maxWidth: 98 },
  squadHeader: {
    panel: { x: 72, y: 377, width: 801, height: 123 },
    from: "#e9e9eb",
    to: "#f9047f",
    titleColour: "#0b0b0d",
    titleFontSize: 66,
    keep: [{ x: 80, y: 340, width: 190, height: 160 }],
  },
  reserves: { centreX: 470, centreY: 1096, fontSize: 19, colour: "#ffffff", maxWidth: 760 },
};

const nine = (p: string) => Array.from({ length: 9 }, (_, i) => `${p}${i + 1}`);

describe("parseClubGraphicsLayout", () => {
  it("accepts a complete layout and returns it", () => {
    expect(parseClubGraphicsLayout(JSON.parse(JSON.stringify(LAYOUT)))).toEqual(LAYOUT);
  });

  it("accepts a layout with a title word of the club's own for the squad header", () => {
    const withTitle = { ...LAYOUT, squadHeader: { ...LAYOUT.squadHeader, title: "THE LIST" } };
    expect(parseClubGraphicsLayout(withTitle)?.squadHeader.title).toBe("THE LIST");
  });

  it("refuses junk, a wrong version, no rows, or a column that is not two", () => {
    expect(parseClubGraphicsLayout(null)).toBeNull();
    expect(parseClubGraphicsLayout("{}")).toBeNull();
    expect(parseClubGraphicsLayout({ ...LAYOUT, version: 2 })).toBeNull();
    expect(parseClubGraphicsLayout({ ...LAYOUT, rows: [] })).toBeNull();
    expect(parseClubGraphicsLayout({ ...LAYOUT, columns: [LAYOUT.columns[0]] })).toBeNull();
    expect(parseClubGraphicsLayout({ ...LAYOUT, name: { ...LAYOUT.name, minFontSize: 50 } })).toBeNull();
  });

  it("refuses a colour that is not a hex colour (it is put into the drawing as is)", () => {
    expect(parseClubGraphicsLayout({ ...LAYOUT, name: { ...LAYOUT.name, colour: "red;background:url(x)" } })).toBeNull();
  });
});

describe("templateChoice", () => {
  it("the team sheet uses the template when both teams fill its rows exactly", () => {
    expect(templateChoice({ kind: "teams", teams: [{ names: nine("a") }, { names: nine("b") }] }, LAYOUT)).toEqual({ design: "template" });
  });

  it("any other team size falls back to the default design (7, 8 and 10 a side, or uneven)", () => {
    for (const [a, b] of [
      [7, 7],
      [8, 8],
      [10, 10],
      [9, 8],
      [10, 9],
    ]) {
      const teams = [{ names: nine("a").concat(["x"]).slice(0, a) }, { names: nine("b").concat(["y"]).slice(0, b) }] as const;
      expect(templateChoice({ kind: "teams", teams: [teams[0], teams[1]] }, LAYOUT), `${a}v${b}`).toEqual({ design: "default", reason: "team-size" });
    }
  });

  it("the list poster uses the template up to two columns of rows (18), the default beyond", () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
    for (const n of [0, 1, 9, 10, 17, 18]) expect(templateChoice({ kind: "list", players: names(n) }, LAYOUT), String(n)).toEqual({ design: "template" });
    expect(templateChoice({ kind: "list", players: names(19) }, LAYOUT)).toEqual({ design: "default", reason: "list-too-long" });
  });
});

describe("graphicDesign (what the route draws)", () => {
  const teams = { kind: "teams" as const, teams: [{ names: nine("a") }, { names: nine("b") }] as const };

  it("no template: the default design, because there is none", () => {
    expect(graphicDesign(teams, null)).toEqual({ design: "default", reason: "no-template" });
  });

  it("a template and a graphic it can hold: the template", () => {
    expect(graphicDesign(teams, LAYOUT)).toEqual({ design: "template" });
  });

  it("a template that cannot hold the graphic: the default design, with why", () => {
    expect(graphicDesign({ kind: "teams", teams: [{ names: nine("a").slice(0, 8) }, { names: nine("b") }] }, LAYOUT)).toEqual({
      design: "default",
      reason: "team-size",
    });
  });
});

/** A fake font: every character is half an em wide. */
const halfEm = (text: string, size: number) => Array.from(text).length * size * 0.5;

describe("fitTemplateName", () => {
  const box = { maxWidth: 200, maxFontSize: 40, minFontSize: 26, measure: halfEm };

  it("a short name keeps the template's size", () => {
    expect(fitTemplateName("ALI", box)).toEqual({ text: "ALI", fontSize: 40 });
  });

  it("a name exactly at the width keeps the size", () => {
    expect(fitTemplateName("ABCDEFGHIJ", box)).toEqual({ text: "ABCDEFGHIJ", fontSize: 40 });
  });

  it("a longer name shrinks until it fits, never below the minimum", () => {
    const r = fitTemplateName("ABCDEFGHIJKLM", box); // 13 chars: 200 / 6.5 = 30.7
    expect(r.text).toBe("ABCDEFGHIJKLM");
    expect(r.fontSize).toBe(30);
    expect(halfEm(r.text, r.fontSize)).toBeLessThanOrEqual(200);
  });

  it("a name too long even at the minimum is cut with an ellipsis that fits", () => {
    const r = fitTemplateName("MUHAMMADABDULRAHMANALEXANDER", box);
    expect(r.fontSize).toBe(26);
    expect(r.text.endsWith("…")).toBe(true);
    expect(halfEm(r.text, r.fontSize)).toBeLessThanOrEqual(200);
    expect(r.text.length).toBeGreaterThan(10);
  });

  it("an emoji or a Turkish letter is never split by the cut", () => {
    const r = fitTemplateName("ŞÜKRÜ🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥", { ...box, measure: (t, s) => Array.from(new Intl.Segmenter().segment(t)).length * s * 0.5 });
    expect(r.text.startsWith("ŞÜKRÜ")).toBe(true);
    expect(r.text).not.toMatch(/�/);
  });
});

describe("date and time in the template's style (London)", () => {
  // Fri 16 Oct 2026, 20:30 London (19:30 UTC, BST).
  const fri = new Date("2026-10-16T19:30:00Z");

  it("English: an ordinal day and the full month, 12-hour time with a lower-case suffix", () => {
    expect(templateDateLabel("en", fri)).toBe("16th October");
    expect(templateTimeLabel("en", fri)).toBe("8:30pm");
  });

  it("ordinals: 1st, 2nd, 3rd, 11th, 22nd", () => {
    expect(templateDateLabel("en", new Date("2026-10-01T12:00:00Z"))).toBe("1st October");
    expect(templateDateLabel("en", new Date("2026-10-02T12:00:00Z"))).toBe("2nd October");
    expect(templateDateLabel("en", new Date("2026-10-03T12:00:00Z"))).toBe("3rd October");
    expect(templateDateLabel("en", new Date("2026-10-11T12:00:00Z"))).toBe("11th October");
    expect(templateDateLabel("en", new Date("2026-10-22T12:00:00Z"))).toBe("22nd October");
  });

  it("on the hour: 9pm, not 9:00pm", () => {
    expect(templateTimeLabel("en", new Date("2026-10-16T20:00:00Z"))).toBe("9pm");
  });

  it("Turkish: day and month, 24-hour time", () => {
    expect(templateDateLabel("tr", fri)).toBe("16 Ekim");
    expect(templateTimeLabel("tr", fri)).toBe("20:30");
  });

  it("after the clocks go back the time is still London's (GMT)", () => {
    const nov = new Date("2026-11-06T20:30:00Z");
    expect(templateTimeLabel("en", nov)).toBe("8:30pm");
    expect(templateDateLabel("en", nov)).toBe("6th November");
  });
});

describe("reservesLine", () => {
  const opts = { label: "RESERVES", more: (n: number) => `+${n} more`, maxWidth: 200, fontSize: 20, measure: halfEm };

  it("no reserves, no line", () => {
    expect(reservesLine([], opts)).toBeNull();
  });

  it("all the reserves when they fit", () => {
    expect(reservesLine(["SAM", "JOE"], opts)).toBe("RESERVES: SAM, JOE");
  });

  it("as many as fit, then how many more", () => {
    const line = reservesLine(["ALEXANDER", "BARTHOLOMEW", "CHRISTOPHER", "DOMINIC", "EZEKIEL"], { ...opts, maxWidth: 400 })!;
    expect(line).toBe("RESERVES: ALEXANDER, BARTHOLOMEW +3 more");
    expect(halfEm(line, 20)).toBeLessThanOrEqual(400);
  });
});

describe("brandSubtitleLabel: the line under the club's name on a shared template", () => {
  it("an evening kickoff: '<WEEKDAY> NIGHT FOOTBALL', London's day", () => {
    expect(brandSubtitleLabel("en", new Date("2026-10-13T19:00:00Z"))).toBe("TUESDAY NIGHT FOOTBALL");
    // 23:30 London on a Friday is still Friday (22:30 UTC in BST).
    expect(brandSubtitleLabel("en", new Date("2026-10-16T22:30:00Z"))).toBe("FRIDAY NIGHT FOOTBALL");
  });

  it("a daytime kickoff: '<WEEKDAY> FOOTBALL'", () => {
    expect(brandSubtitleLabel("en", new Date("2026-10-18T09:00:00Z"))).toBe("SUNDAY FOOTBALL");
  });

  it("in Turkish, in Turkish capitals", () => {
    expect(brandSubtitleLabel("tr", new Date("2026-10-13T19:00:00Z"))).toBe("SALI AKŞAMI FUTBOLU");
    expect(brandSubtitleLabel("tr", new Date("2026-10-15T19:00:00Z"))).toBe("PERŞEMBE AKŞAMI FUTBOLU");
    expect(brandSubtitleLabel("tr", new Date("2026-10-18T09:00:00Z"))).toBe("PAZAR FUTBOLU");
  });
});

describe("parseClubGraphicsLayout: brandArea (2026-10-14, shared templates)", () => {
  const brandArea = { x: 300, y: 60, width: 340, height: 120, fill: "#0b0b0d", colour: "#ffffff", maxFontSize: 64 };

  it("is optional: a layout without one (FNF's today) still parses, with none", () => {
    expect(parseClubGraphicsLayout(JSON.parse(JSON.stringify(LAYOUT)))?.brandArea).toBeUndefined();
  });

  it("a layout that declares one keeps it", () => {
    expect(parseClubGraphicsLayout({ ...LAYOUT, brandArea })?.brandArea).toEqual(brandArea);
  });

  it("on an image whose branding is already painted out: no fill, the name's own centre and a subtitle line", () => {
    const clean = { x: 236, y: 206, width: 468, height: 132, colour: "#ececee", maxFontSize: 96, nameCentreY: 266, subtitle: { centreY: 329, fontSize: 17, colour: "#ffffff", letterSpacing: 5 } };
    expect(parseClubGraphicsLayout({ ...LAYOUT, brandArea: clean })?.brandArea).toEqual(clean);
    expect(parseClubGraphicsLayout({ ...LAYOUT, brandArea: { ...clean, subtitle: { centreY: 329 } } })).toBeNull();
  });

  it("a broken one makes the layout unusable, rather than drawing a club's logo for another club", () => {
    expect(parseClubGraphicsLayout({ ...LAYOUT, brandArea: { ...brandArea, fill: "black" } })).toBeNull();
    expect(parseClubGraphicsLayout({ ...LAYOUT, brandArea: { ...brandArea, width: -1 } })).toBeNull();
    expect(parseClubGraphicsLayout({ ...LAYOUT, brandArea: { x: 1 } })).toBeNull();
  });
});
