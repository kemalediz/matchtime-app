/**
 * Reading a club's graphics template from the database (mocked at
 * `@/lib/db`): present and valid, absent, broken, or the table not there
 * yet. Anything but a usable template is null, so the graphic is drawn in
 * the default design and never fails for it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ clubGraphicsTemplate: { findUnique: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { loadClubGraphicsTemplate } from "../club-graphics-template";

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

beforeEach(() => {
  dbMock.clubGraphicsTemplate.findUnique.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loadClubGraphicsTemplate", () => {
  it("a club's template: its image bytes, type and checked layout", async () => {
    dbMock.clubGraphicsTemplate.findUnique.mockResolvedValue({ image: new Uint8Array(IMAGE), mimeType: "image/jpeg", layout: LAYOUT });
    const t = await loadClubGraphicsTemplate("org-1");
    expect(dbMock.clubGraphicsTemplate.findUnique).toHaveBeenCalledWith({ where: { orgId: "org-1" }, select: { image: true, mimeType: true, layout: true } });
    expect(t).not.toBeNull();
    expect(Buffer.from(t!.image).equals(IMAGE)).toBe(true);
    expect(t!.mimeType).toBe("image/jpeg");
    expect(t!.layout.rows).toEqual([100, 140]);
  });

  it("no template for the club: null", async () => {
    dbMock.clubGraphicsTemplate.findUnique.mockResolvedValue(null);
    expect(await loadClubGraphicsTemplate("org-1")).toBeNull();
  });

  it("a layout this code cannot draw: null, logged by org id only", async () => {
    dbMock.clubGraphicsTemplate.findUnique.mockResolvedValue({ image: IMAGE, mimeType: "image/jpeg", layout: { version: 9 } });
    expect(await loadClubGraphicsTemplate("org-1")).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("org=org-1"));
  });

  it("an image type other than JPEG or PNG, or no bytes: null", async () => {
    dbMock.clubGraphicsTemplate.findUnique.mockResolvedValue({ image: IMAGE, mimeType: "image/svg+xml", layout: LAYOUT });
    expect(await loadClubGraphicsTemplate("org-1")).toBeNull();
    dbMock.clubGraphicsTemplate.findUnique.mockResolvedValue({ image: Buffer.alloc(0), mimeType: "image/png", layout: LAYOUT });
    expect(await loadClubGraphicsTemplate("org-1")).toBeNull();
  });

  it("the table not there yet (migration not applied): null, not a failure", async () => {
    dbMock.clubGraphicsTemplate.findUnique.mockRejectedValue(new Error('relation "ClubGraphicsTemplate" does not exist'));
    expect(await loadClubGraphicsTemplate("org-1")).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("org=org-1"));
  });
});
