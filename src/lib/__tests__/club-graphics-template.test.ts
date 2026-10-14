/**
 * Reading a club's graphics design from the database (mocked at
 * `@/lib/db`):
 *
 *   - its own template: a MEASURED one (names in measured rows, FNF's) or
 *     a BACKGROUND one (an owner's upload), present and valid, absent,
 *     broken, or the table not there yet; anything but a usable template
 *     is null, so the graphic is drawn in the default design and never
 *     fails for it;
 *   - the columns this change adds not there yet (code deployed before
 *     the migration): the template is still read the old way, so FNF's
 *     board keeps working whichever goes first;
 *   - which design is drawn (`loadClubDesign`): the club's choice, its
 *     own template, a shared one (always drawn as foreign), or the
 *     default; another club's private template never.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  clubGraphicsTemplate: { findUnique: vi.fn(), findMany: vi.fn() },
  clubGraphicsChoice: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { loadClubDesign, loadClubDesignById, loadClubGraphicsTemplate } from "../club-graphics-template";

const LAYOUT = {
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
  squadHeader: { panel: { x: 10, y: 60, width: 280, height: 30 }, from: "#ffffff", to: "#ff00aa", titleColour: "#000000", titleFontSize: 24, keep: [] },
  reserves: { centreX: 150, centreY: 200, fontSize: 12, colour: "#ffffff", maxWidth: 260 },
};

const IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const FULL_SELECT = { orgId: true, image: true, mimeType: true, layout: true, kind: true, shared: true, displayName: true, sharedImage: true, sharedMimeType: true, sharedLayout: true };

const measured = (orgId: string, extra: Record<string, unknown> = {}) => ({
  orgId,
  image: new Uint8Array(IMAGE),
  mimeType: "image/jpeg",
  layout: LAYOUT,
  kind: "measured",
  shared: false,
  displayName: null,
  ...extra,
});
const background = (orgId: string, extra: Record<string, unknown> = {}) => ({
  orgId,
  image: new Uint8Array(IMAGE),
  mimeType: "image/jpeg",
  layout: { width: 1080, height: 1350 },
  kind: "background",
  shared: false,
  displayName: null,
  ...extra,
});

/** Template rows by org id; a missing id is "no row". */
function templates(rows: Record<string, unknown>) {
  dbMock.clubGraphicsTemplate.findUnique.mockImplementation(async (q: { where: { orgId: string } }) => rows[q.where.orgId] ?? null);
}

beforeEach(() => {
  dbMock.clubGraphicsTemplate.findUnique.mockReset();
  dbMock.clubGraphicsTemplate.findMany.mockReset().mockResolvedValue([]);
  dbMock.clubGraphicsChoice.findUnique.mockReset().mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loadClubGraphicsTemplate", () => {
  it("a club's measured template: its image bytes, type and checked layout", async () => {
    templates({ "org-1": measured("org-1") });
    const t = await loadClubGraphicsTemplate("org-1");
    expect(dbMock.clubGraphicsTemplate.findUnique).toHaveBeenCalledWith({ where: { orgId: "org-1" }, select: FULL_SELECT });
    expect(t?.kind).toBe("measured");
    expect(Buffer.from(t!.image).equals(IMAGE)).toBe(true);
    expect(t!.mimeType).toBe("image/jpeg");
    if (t?.kind === "measured") expect(t.layout.rows).toEqual([100, 140]);
  });

  it("a club's background: its bytes, type and size", async () => {
    templates({ "org-1": background("org-1") });
    expect(await loadClubGraphicsTemplate("org-1")).toMatchObject({ kind: "background", mimeType: "image/jpeg", width: 1080, height: 1350 });
  });

  it("no template for the club: null", async () => {
    templates({});
    expect(await loadClubGraphicsTemplate("org-1")).toBeNull();
  });

  it("a layout this code cannot draw: null, logged by org id only", async () => {
    templates({ "org-1": measured("org-1", { layout: { version: 9 } }) });
    expect(await loadClubGraphicsTemplate("org-1")).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("org=org-1"));
  });

  it("an image type other than JPEG or PNG, or no bytes, or an unknown kind: null", async () => {
    templates({ "org-1": measured("org-1", { mimeType: "image/svg+xml" }) });
    expect(await loadClubGraphicsTemplate("org-1")).toBeNull();
    templates({ "org-1": measured("org-1", { image: Buffer.alloc(0), mimeType: "image/png" }) });
    expect(await loadClubGraphicsTemplate("org-1")).toBeNull();
    templates({ "org-1": background("org-1", { mimeType: "image/webp" }) });
    expect(await loadClubGraphicsTemplate("org-1")).toBeNull();
    templates({ "org-1": measured("org-1", { kind: "hologram" }) });
    expect(await loadClubGraphicsTemplate("org-1")).toBeNull();
  });

  it("the table not there yet (migration not applied): null, not a failure", async () => {
    dbMock.clubGraphicsTemplate.findUnique.mockRejectedValue(new Error('relation "ClubGraphicsTemplate" does not exist'));
    expect(await loadClubGraphicsTemplate("org-1")).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("org=org-1"));
  });

  it("the new columns not there yet (code before the migration): read the old way, as a measured template", async () => {
    dbMock.clubGraphicsTemplate.findUnique
      .mockRejectedValueOnce(new Error('column ClubGraphicsTemplate.kind does not exist'))
      .mockResolvedValueOnce({ orgId: "org-1", image: new Uint8Array(IMAGE), mimeType: "image/jpeg", layout: LAYOUT });
    const t = await loadClubGraphicsTemplate("org-1");
    expect(t?.kind).toBe("measured");
    expect(dbMock.clubGraphicsTemplate.findUnique).toHaveBeenLastCalledWith({
      where: { orgId: "org-1" },
      select: { orgId: true, image: true, mimeType: true, layout: true },
    });
  });
});

describe("loadClubDesign", () => {
  it("no choice, no template: the default design", async () => {
    templates({});
    expect(await loadClubDesign("org-1")).toEqual({ source: "matchtime", template: null, foreign: false });
  });

  it("FNF today (its own template, no choice row, or the choice table not there yet): its own template", async () => {
    templates({ fnf: measured("fnf") });
    expect(await loadClubDesign("fnf")).toMatchObject({ source: "own", foreign: false, template: { kind: "measured" } });
    dbMock.clubGraphicsChoice.findUnique.mockRejectedValue(new Error('relation "ClubGraphicsChoice" does not exist'));
    expect(await loadClubDesign("fnf")).toMatchObject({ source: "own", foreign: false, template: { kind: "measured" } });
  });

  it("'MatchTime' chosen: the default, though the club has its own", async () => {
    templates({ "org-1": background("org-1") });
    dbMock.clubGraphicsChoice.findUnique.mockResolvedValue({ design: "matchtime", sharedFromOrgId: null });
    expect(await loadClubDesign("org-1")).toEqual({ source: "matchtime", template: null, foreign: false });
  });

  it("a shared template chosen: drawn as foreign", async () => {
    templates({ owner: measured("owner", { shared: true, displayName: "Night stadium" }) });
    dbMock.clubGraphicsChoice.findUnique.mockResolvedValue({ design: "shared", sharedFromOrgId: "owner" });
    expect(await loadClubDesign("org-1")).toMatchObject({ source: "shared", foreign: true, template: { kind: "measured" } });
  });

  it("a shared template with a SHARED VARIANT (FNF's 'Floodlights'): other clubs get the variant, its own club the branded one", async () => {
    const VARIANT = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
    const variantLayout = { ...LAYOUT, brandArea: { x: 10, y: 10, width: 200, height: 40, colour: "#ffffff", maxFontSize: 30 } };
    const fnf = measured("fnf", { shared: true, displayName: "Floodlights", sharedImage: new Uint8Array(VARIANT), sharedMimeType: "image/jpeg", sharedLayout: variantLayout });
    templates({ fnf });
    dbMock.clubGraphicsChoice.findUnique.mockResolvedValue({ design: "shared", sharedFromOrgId: "fnf" });
    const other = await loadClubDesign("org-1");
    expect(other).toMatchObject({ source: "shared", foreign: true, template: { kind: "measured" } });
    expect(Buffer.from(other.template!.image).equals(VARIANT)).toBe(true);
    if (other.template?.kind === "measured") expect(other.template.layout.brandArea?.width).toBe(200);

    dbMock.clubGraphicsChoice.findUnique.mockResolvedValue(null);
    const own = await loadClubDesign("fnf");
    expect(own).toMatchObject({ source: "own", foreign: false });
    expect(Buffer.from(own.template!.image).equals(IMAGE)).toBe(true);
    if (own.template?.kind === "measured") expect(own.template.layout.brandArea).toBeUndefined();

    // The gallery's thumbnail for another club: the variant too.
    const thumb = await loadClubDesignById("org-1", "shared:fnf");
    expect(Buffer.from(thumb!.template!.image).equals(VARIANT)).toBe(true);
  });

  it("a shared variant that cannot be drawn: other clubs get the default, never the branded original", async () => {
    templates({ fnf: measured("fnf", { shared: true, sharedImage: new Uint8Array(IMAGE), sharedMimeType: "image/jpeg", sharedLayout: { version: 9 } }) });
    dbMock.clubGraphicsChoice.findUnique.mockResolvedValue({ design: "shared", sharedFromOrgId: "fnf" });
    expect(await loadClubDesign("org-1")).toEqual({ source: "matchtime", template: null, foreign: false });
  });

  it("a chosen template that is no longer shared: never drawn for another club", async () => {
    templates({ owner: measured("owner", { shared: false }) });
    dbMock.clubGraphicsChoice.findUnique.mockResolvedValue({ design: "shared", sharedFromOrgId: "owner" });
    expect(await loadClubDesign("org-1")).toEqual({ source: "matchtime", template: null, foreign: false });
  });

  it("its own template unusable: the default, never an error", async () => {
    templates({ "org-1": measured("org-1", { layout: { version: 9 } }) });
    expect(await loadClubDesign("org-1")).toEqual({ source: "matchtime", template: null, foreign: false });
  });
});

describe("loadClubDesignById: the gallery's preview of one option", () => {
  it("'matchtime': the default", async () => {
    templates({});
    expect(await loadClubDesignById("org-1", "matchtime")).toEqual({ source: "matchtime", template: null, foreign: false });
  });

  it("'own' with none: not available (null)", async () => {
    templates({});
    expect(await loadClubDesignById("org-1", "own")).toBeNull();
  });

  it("another club's shared template: foreign; its private one: not available", async () => {
    templates({ a: measured("a", { shared: true }), b: measured("b", { shared: false }) });
    expect(await loadClubDesignById("org-1", "shared:a")).toMatchObject({ source: "shared", foreign: true });
    expect(await loadClubDesignById("org-1", "shared:b")).toBeNull();
  });

  it("junk: null", async () => {
    templates({});
    expect(await loadClubDesignById("org-1", "../etc")).toBeNull();
  });
});
