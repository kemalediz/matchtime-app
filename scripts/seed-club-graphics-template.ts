/**
 * Store a club's own graphics template (background + layout) on the club.
 *
 * DRY RUN by default. Pass --apply to write.
 *
 *   node --env-file=.env --import tsx scripts/seed-club-graphics-template.ts <orgId> <image.jpg|png> <layout.json>
 *   node --env-file=.env --import tsx scripts/seed-club-graphics-template.ts <orgId> <image.jpg|png> <layout.json> --apply
 *
 * For FNF, the image and layout come from
 * scripts/build-fnf-graphics-template.ts (kept outside the repo: they
 * carry FNF's branding). One row per club: running it again replaces the
 * club's template. To remove one:
 *   DELETE FROM "ClubGraphicsTemplate" WHERE "orgId" = '<orgId>';
 *
 * Checks before writing: the org exists, the layout is one the renderer
 * can draw (`parseClubGraphicsLayout`), the image is a JPEG or PNG whose
 * pixel size is the layout's. Needs the ClubGraphicsTemplate table
 * (prisma/migrations/20261014170000_club_graphics_template). Prints ids
 * and sizes only.
 */
import { readFile } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { parseClubGraphicsLayout } from "../src/lib/club-graphics-layout.ts";

/** Width and height from a PNG's IHDR or a JPEG's first SOF marker, with the type. */
function imageInfo(buf: Buffer): { mimeType: "image/png" | "image/jpeg"; width: number; height: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { mimeType: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mimeType: "image/jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const [orgId, imagePath, layoutPath] = args.filter((a) => !a.startsWith("--"));
  if (!orgId || !imagePath || !layoutPath) {
    console.error("usage: seed-club-graphics-template.ts <orgId> <image> <layout.json> [--apply]");
    process.exit(1);
  }

  const image = await readFile(imagePath);
  const info = imageInfo(image);
  if (!info) throw new Error("the image is not a JPEG or PNG");
  const layout = parseClubGraphicsLayout(JSON.parse(await readFile(layoutPath, "utf8")));
  if (!layout) throw new Error("the layout is not one the renderer can draw (see src/lib/club-graphics-layout.ts)");
  if (info.width !== layout.width || info.height !== layout.height) {
    throw new Error(`the image is ${info.width}x${info.height}, the layout ${layout.width}x${layout.height}`);
  }

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as never);
  try {
    const org = await db.organisation.findUnique({ where: { id: orgId }, select: { id: true } });
    if (!org) throw new Error(`no organisation ${orgId}`);
    const existing = await db.clubGraphicsTemplate.findUnique({ where: { orgId }, select: { orgId: true } });
    console.log(`${apply ? "APPLY" : "DRY RUN"}: org=${orgId} ${existing ? "replace" : "create"} ${info.mimeType} ${info.width}x${info.height} bytes=${image.length} rows=${layout.rows.length}`);
    if (!apply) return;
    const data = { image: new Uint8Array(image), mimeType: info.mimeType, layout };
    await db.clubGraphicsTemplate.upsert({ where: { orgId }, create: { orgId, ...data }, update: data });
    console.log("done");
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
