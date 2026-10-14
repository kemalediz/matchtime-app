/**
 * A CLUB'S GRAPHICS TEMPLATE, READ FROM THE DATABASE (2026-10-14).
 *
 * One `ClubGraphicsTemplate` row per club at most: the blank background
 * (JPEG or PNG bytes) and its layout (`club-graphics-layout.ts`). It is
 * club data, stored with the club and seeded by
 * `scripts/seed-club-graphics-template.ts`, never committed to the repo.
 *
 * Anything but a usable template reads as null, and the graphic is drawn
 * in the default MatchTime design: no row, a layout this code cannot draw,
 * an image type the renderer does not take, or the table not there yet
 * (the migration is applied by hand). A broken template is logged with the
 * club's id only; it never fails the graphic.
 */
import { db } from "./db";
import { parseClubGraphicsLayout, type ClubGraphicsLayout } from "./club-graphics-layout";

export interface ClubGraphicsTemplate {
  image: Buffer;
  mimeType: "image/jpeg" | "image/png";
  layout: ClubGraphicsLayout;
}

const TYPES = new Set(["image/jpeg", "image/png"]);

export async function loadClubGraphicsTemplate(orgId: string): Promise<ClubGraphicsTemplate | null> {
  let row: { image: Uint8Array; mimeType: string; layout: unknown } | null;
  try {
    row = await db.clubGraphicsTemplate.findUnique({ where: { orgId }, select: { image: true, mimeType: true, layout: true } });
  } catch (err) {
    console.error(`[graphics] template read failed org=${orgId}: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`);
    return null;
  }
  if (!row) return null;

  const layout = parseClubGraphicsLayout(row.layout);
  if (!layout || !TYPES.has(row.mimeType) || row.image.length === 0) {
    console.error(`[graphics] template unusable org=${orgId} type=${row.mimeType} bytes=${row.image.length} layout=${layout ? "ok" : "invalid"}`);
    return null;
  }
  return { image: Buffer.from(row.image), mimeType: row.mimeType as ClubGraphicsTemplate["mimeType"], layout };
}
