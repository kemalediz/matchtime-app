/**
 * Which design a club's list poster and team sheet are drawn in
 * (2026-10-14, "Posters"): the rules, pure.
 *
 *   - a club's own (private) template beats a shared one it did not pick,
 *     a shared one it picked beats the default, and "MatchTime" picked
 *     is the default;
 *   - another club's template is used only while it is SHARED, and is
 *     always drawn as "foreign" (its own words and branding kept out);
 *   - another club's private template is never offered and never used;
 *   - a shared template's gallery name may not carry its club's name.
 */
import { describe, expect, it } from "vitest";
import {
  designOptions,
  displayNameProblem,
  foreignLayout,
  parseDesignId,
  resolveDesign,
  type TemplateMeta,
} from "../club-graphics-choice";
import { parseClubGraphicsLayout } from "../club-graphics-layout";

const ORG = "org-me";
const own = (kind: TemplateMeta["kind"] = "measured", shared = false): TemplateMeta => ({ orgId: ORG, kind, shared, displayName: null });
const other = (orgId = "org-other", shared = true, displayName: string | null = "Night stadium"): TemplateMeta => ({
  orgId,
  kind: "measured",
  shared,
  displayName,
});

describe("resolveDesign: private beats shared beats default", () => {
  it("nothing stored: the MatchTime design", () => {
    expect(resolveDesign({ orgId: ORG, choice: null, own: null, shared: null })).toEqual({ source: "matchtime" });
  });

  it("an own template and no choice made (FNF today): the own template", () => {
    expect(resolveDesign({ orgId: ORG, choice: null, own: own(), shared: null })).toEqual({ source: "own", templateOrgId: ORG });
  });

  it("an own template and 'own' chosen: the own template", () => {
    expect(resolveDesign({ orgId: ORG, choice: { design: "own", sharedFromOrgId: null }, own: own(), shared: null })).toEqual({
      source: "own",
      templateOrgId: ORG,
    });
  });

  it("'MatchTime' chosen: the default, even with an own template", () => {
    expect(resolveDesign({ orgId: ORG, choice: { design: "matchtime", sharedFromOrgId: null }, own: own(), shared: null })).toEqual({
      source: "matchtime",
    });
  });

  it("a shared template chosen: that template, drawn for this club", () => {
    expect(
      resolveDesign({ orgId: ORG, choice: { design: "shared", sharedFromOrgId: "org-other" }, own: null, shared: other() }),
    ).toEqual({ source: "shared", templateOrgId: "org-other" });
  });

  it("a shared template chosen that is no longer shared: own if there is one, else default", () => {
    const choice = { design: "shared" as const, sharedFromOrgId: "org-other" };
    expect(resolveDesign({ orgId: ORG, choice, own: own(), shared: other("org-other", false) })).toEqual({ source: "own", templateOrgId: ORG });
    expect(resolveDesign({ orgId: ORG, choice, own: null, shared: other("org-other", false) })).toEqual({ source: "matchtime" });
  });

  it("a shared template chosen that was deleted (the reference went null): own, else default", () => {
    expect(resolveDesign({ orgId: ORG, choice: { design: "shared", sharedFromOrgId: null }, own: own(), shared: null })).toEqual({
      source: "own",
      templateOrgId: ORG,
    });
    expect(resolveDesign({ orgId: ORG, choice: { design: "shared", sharedFromOrgId: null }, own: null, shared: null })).toEqual({
      source: "matchtime",
    });
  });

  it("the shared row passed in is not the one chosen: never used", () => {
    expect(
      resolveDesign({ orgId: ORG, choice: { design: "shared", sharedFromOrgId: "org-x" }, own: null, shared: other("org-y") }),
    ).toEqual({ source: "matchtime" });
  });

  it("another club's template passed as 'own': never used", () => {
    expect(resolveDesign({ orgId: ORG, choice: null, own: other("org-other", false), shared: null })).toEqual({ source: "matchtime" });
  });

  it("'shared' pointing at the club's own template: it is the own template, not a foreign one", () => {
    expect(resolveDesign({ orgId: ORG, choice: { design: "shared", sharedFromOrgId: ORG }, own: own("measured", true), shared: own("measured", true) })).toEqual({
      source: "own",
      templateOrgId: ORG,
    });
  });
});

describe("designOptions: the gallery", () => {
  it("no own template, no shared ones: MatchTime only", () => {
    expect(designOptions(ORG, null, [])).toEqual([{ id: "matchtime", source: "matchtime", kind: null, label: null }]);
  });

  it("an own template: MatchTime and 'own' (its kind said, no label: the page names it)", () => {
    expect(designOptions(ORG, own("background"), [])).toEqual([
      { id: "matchtime", source: "matchtime", kind: null, label: null },
      { id: "own", source: "own", kind: "background", label: null },
    ]);
  });

  it("shared templates from other clubs, by their display name; the club's own shared one appears once, as 'own'", () => {
    const opts = designOptions(ORG, own("measured", true), [own("measured", true), other("org-a", true, "Night stadium"), other("org-b", true, null)]);
    expect(opts.map((o) => o.id)).toEqual(["matchtime", "own", "shared:org-a", "shared:org-b"]);
    expect(opts[2]).toEqual({ id: "shared:org-a", source: "shared", kind: "measured", label: "Night stadium" });
    // No display name: the page gives it a generic one, never the club's.
    expect(opts[3].label).toBeNull();
  });

  it("another club's PRIVATE template is never offered, even if handed in", () => {
    expect(designOptions(ORG, null, [other("org-a", false)]).map((o) => o.id)).toEqual(["matchtime"]);
  });
});

describe("parseDesignId", () => {
  it("reads the three kinds of id", () => {
    expect(parseDesignId("matchtime")).toEqual({ source: "matchtime" });
    expect(parseDesignId("own")).toEqual({ source: "own" });
    expect(parseDesignId("shared:org-a")).toEqual({ source: "shared", templateOrgId: "org-a" });
  });

  it("anything else: null", () => {
    for (const bad of ["", "shared:", "shared: ", "default", "own:x", 7, null, undefined, "shared:" + "x".repeat(200)]) {
      expect(parseDesignId(bad as unknown as string)).toBeNull();
    }
  });
});

describe("displayNameProblem: what other clubs see a shared template called", () => {
  it("a neutral name is fine", () => {
    expect(displayNameProblem("Night stadium", "Friday Night Football")).toBeNull();
  });

  it("empty or too long", () => {
    expect(displayNameProblem("  ", "FNF")).toBe("empty");
    expect(displayNameProblem("x".repeat(41), "FNF")).toBe("too-long");
  });

  it("carrying the club's name, in any case or spacing: refused", () => {
    expect(displayNameProblem("FNF night board", "FNF")).toBe("names-club");
    expect(displayNameProblem("friday  night football board", "Friday Night Football")).toBe("names-club");
    expect(displayNameProblem("Galatasaray Gece", "galatasaray")).toBe("names-club");
  });
});

describe("foreignLayout: a shared measured template drawn for another club", () => {
  const LAYOUT = parseClubGraphicsLayout({
    version: 1,
    width: 300,
    height: 500,
    rows: [100, 140],
    capHeight: 20,
    name: { colour: "#ffffff", maxFontSize: 30, minFontSize: 18 },
    columns: [
      { nameX: 40, maxWidth: 100, iconCentreX: 20, badgeColour: "#000000" },
      { nameX: 180, maxWidth: 100, iconCentreX: 160, badgeColour: "#ffffff" },
    ],
    date: { x: 200, centreY: 30, fontSize: 14, colour: "#ffffff", maxWidth: 90 },
    time: { x: 200, centreY: 50, fontSize: 14, colour: "#ffffff", maxWidth: 90 },
    squadHeader: { panel: { x: 10, y: 60, width: 280, height: 30 }, from: "#ffffff", to: "#ff00aa", titleColour: "#000000", titleFontSize: 24, title: "FNF SQUAD", keep: [] },
    reserves: { centreX: 150, centreY: 200, fontSize: 12, colour: "#ffffff", maxWidth: 260 },
  })!;

  it("drops the template's own squad title (it may name its club); the rest is unchanged", () => {
    expect(LAYOUT.squadHeader.title).toBe("FNF SQUAD");
    const f = foreignLayout(LAYOUT);
    expect(f.squadHeader.title).toBeUndefined();
    expect(f.rows).toEqual(LAYOUT.rows);
    expect(LAYOUT.squadHeader.title).toBe("FNF SQUAD"); // not mutated
  });
});
