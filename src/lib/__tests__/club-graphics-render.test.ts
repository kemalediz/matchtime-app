/**
 * Drawing on a club's chosen design (2026-10-14, "Posters"), checked on
 * the pixels of the real PNG (next/og renders under vitest; sharp reads
 * the result back):
 *
 *   - a BACKGROUND design (an owner's upload): the default MatchTime board
 *     (header, names, footer, team colours) on a semi-transparent dark
 *     panel over the owner's picture, at 1080 x 1350, the picture still
 *     showing round the edge;
 *   - a SHARED measured template drawn for another club: its `brandArea`
 *     covered (and the picking club's name drawn there); drawn for its own
 *     club, the area is left as the club made it.
 *
 * Every background is an invented flat colour or gradient; every name is
 * invented.
 */
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { renderClubGraphic } from "../club-graphics-render";
import { parseClubGraphicsLayout } from "../club-graphics-layout";
import type { ClubGraphicsTemplate } from "../club-graphics-template";
import type { ListPosterData, TeamSheetData } from "../match-graphics";

const BASE = { clubName: "Invented FC", lang: "en" as const, matchDate: new Date("2026-10-16T19:30:00Z"), kickoff: "20:30", venue: "Invented Park" };
const LIST: ListPosterData = { kind: "list", ...BASE, players: ["Ayla", "Ben", "Cem", "Dan"], reserves: ["Eda"] };
const TEAMS: TeamSheetData = {
  kind: "teams",
  ...BASE,
  teams: [
    { label: "Red", names: ["Ayla", "Ben"] },
    { label: "Yellow", names: ["Cem", "Dan"] },
  ],
};

async function pixel(png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}
const near = (a: number[], b: number[], tol = 24) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function redBackground(): Promise<ClubGraphicsTemplate> {
  const image = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: { r: 220, g: 20, b: 20 } } }).jpeg().toBuffer();
  return { kind: "background", image, mimeType: "image/jpeg", width: 1080, height: 1350 };
}

describe("a background design", () => {
  it("the list poster: 1080 x 1350, the picture round the edge, a darker panel over it", async () => {
    const { png, design } = await renderClubGraphic(LIST, await redBackground());
    expect(design).toEqual({ design: "background" });
    const m = await sharp(png).metadata();
    expect([m.width, m.height]).toEqual([1080, 1350]);
    // The corner: the owner's red, untouched.
    expect(near(await pixel(png, 4, 4), [220, 20, 20])).toBe(true);
    // Inside the panel, away from any text: the red, much darker.
    const inside = await pixel(png, 540, 1000);
    expect(inside[0]).toBeLessThan(140);
  });

  it("the team sheet: the same board with the two coloured team headers, on the picture", async () => {
    const { png, design } = await renderClubGraphic(TEAMS, await redBackground());
    expect(design).toEqual({ design: "background" });
    expect(near(await pixel(png, 4, 4), [220, 20, 20])).toBe(true);
    const m = await sharp(png).metadata();
    expect([m.width, m.height]).toEqual([1080, 1350]);
  });

  it("is not the default design: the default's corner is navy", async () => {
    const { png } = await renderClubGraphic(LIST, null);
    expect(near(await pixel(png, 4, 4), [220, 20, 20])).toBe(false);
  });
});

describe("a measured template's brandArea", () => {
  const layout = parseClubGraphicsLayout({
    version: 1,
    width: 300,
    height: 500,
    rows: [300, 360],
    capHeight: 20,
    name: { colour: "#ffffff", maxFontSize: 30, minFontSize: 18 },
    columns: [
      { nameX: 60, maxWidth: 100, iconCentreX: 30, badgeColour: "#000000" },
      { nameX: 200, maxWidth: 90, iconCentreX: 170, badgeColour: "#ffffff" },
    ],
    date: { x: 200, centreY: 100, fontSize: 14, colour: "#ffffff", maxWidth: 90 },
    time: { x: 200, centreY: 120, fontSize: 14, colour: "#ffffff", maxWidth: 90 },
    squadHeader: { panel: { x: 10, y: 200, width: 280, height: 40 }, from: "#eeeeee", to: "#ff1493", titleColour: "#000000", titleFontSize: 24, title: "OWNERS FC", keep: [] },
    reserves: { centreX: 150, centreY: 420, fontSize: 12, colour: "#ffffff", maxWidth: 260 },
    brandArea: { x: 100, y: 10, width: 120, height: 50, fill: "#00ff00", colour: "#000000", maxFontSize: 28 },
  })!;

  async function template(): Promise<ClubGraphicsTemplate> {
    const image = await sharp({ create: { width: 300, height: 500, channels: 3, background: { r: 24, g: 24, b: 24 } } }).png().toBuffer();
    return { kind: "measured", image, mimeType: "image/png", layout };
  }

  it("drawn for its own club: the brand area is left as it is", async () => {
    const { png, design } = await renderClubGraphic(TEAMS, await template());
    expect(design).toEqual({ design: "template" });
    expect(near(await pixel(png, 102, 12), [24, 24, 24])).toBe(true);
  });

  it("a brand area with no fill (branding already painted out): nothing covered, the club's name and the subtitle line drawn", async () => {
    const clean = parseClubGraphicsLayout({
      ...layout,
      brandArea: { x: 20, y: 10, width: 260, height: 70, colour: "#ffffff", maxFontSize: 40, nameCentreY: 30, subtitle: { centreY: 66, fontSize: 12, colour: "#ffffff", letterSpacing: 3 } },
    })!;
    const image = await sharp({ create: { width: 300, height: 500, channels: 3, background: { r: 24, g: 24, b: 24 } } }).png().toBuffer();
    const { png } = await renderClubGraphic(TEAMS, { kind: "measured", image, mimeType: "image/png", layout: clean }, { foreign: true });
    // The corner of the area: the image, uncovered.
    expect(near(await pixel(png, 22, 12), [24, 24, 24])).toBe(true);
    // White lettering on the name's line and on the subtitle's line.
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const brightOn = (y: number) => {
      let n = 0;
      for (let x = 20; x < 280; x++) if (data[(y * info.width + x) * info.channels] > 200) n++;
      return n;
    };
    expect(brightOn(30)).toBeGreaterThan(10);
    expect(brightOn(66)).toBeGreaterThan(5);
  });

  it("drawn for another club (shared): the brand area is covered with its fill", async () => {
    const { png, design } = await renderClubGraphic(TEAMS, await template(), { foreign: true });
    expect(design).toEqual({ design: "template" });
    expect(near(await pixel(png, 102, 12), [0, 255, 0])).toBe(true);
    expect(near(await pixel(png, 217, 57), [0, 255, 0])).toBe(true);
    // Outside the area: untouched.
    expect(near(await pixel(png, 98, 12), [24, 24, 24])).toBe(true);
  });
});
