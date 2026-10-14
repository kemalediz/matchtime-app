/**
 * Store a club's own graphics template (background + layout) on the club,
 * and (2026-10-14) its SHARED VARIANT for other clubs, and whether it is
 * shared and under what name.
 *
 * DRY RUN by default. Pass --apply to write.
 *
 *   The club's own template (replaces it):
 *     node --env-file=.env --import tsx scripts/seed-club-graphics-template.ts <orgId> <image.jpg|png> <layout.json> [--apply]
 *
 *   The shared variant on a club that already has its template, shared
 *   under a display name (the club's own image is left as it is):
 *     node --env-file=.env --import tsx scripts/seed-club-graphics-template.ts <orgId> \
 *       --shared-image <variant.jpg> --shared-layout <variant-layout.json> \
 *       --display-name "Floodlights" --share [--apply]
 *
 *   Both at once: the positional image and layout plus the --shared-* flags.
 *   --unshare stops sharing (the variant is kept).
 *
 * For FNF, every file comes from scripts/build-fnf-graphics-template.ts
 * (kept outside the repo: they carry FNF's branding): fnf-template.jpg and
 * fnf-layout.json are FNF's own, fnf-shared-template.jpg and
 * fnf-shared-layout.json the "Floodlights" variant other clubs get, with
 * FNF's logo and shirt prints painted out. To remove a template:
 *   DELETE FROM "ClubGraphicsTemplate" WHERE "orgId" = '<orgId>';
 *
 * Checks before writing: the org exists, each layout is one the renderer
 * can draw (`parseClubGraphicsLayout`), each image is a JPEG or PNG whose
 * pixel size is its layout's, the variant's layout has a brandArea (the
 * picking club's name goes there), and a display name does not carry the
 * club's name (`displayNameProblem`). Needs both graphics migrations
 * (20261014170000_club_graphics_template, 20261014190000_club_graphics_designs).
 * Prints ids and sizes only.
 */
import { readFile } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { parseClubGraphicsLayout, type ClubGraphicsLayout } from "../src/lib/club-graphics-layout.ts";
import { displayNameProblem } from "../src/lib/club-graphics-choice.ts";

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

async function readPair(imagePath: string, layoutPath: string, what: string): Promise<{ image: Buffer; mimeType: string; layout: ClubGraphicsLayout }> {
  const image = await readFile(imagePath);
  const info = imageInfo(image);
  if (!info) throw new Error(`the ${what} image is not a JPEG or PNG`);
  const layout = parseClubGraphicsLayout(JSON.parse(await readFile(layoutPath, "utf8")));
  if (!layout) throw new Error(`the ${what} layout is not one the renderer can draw (see src/lib/club-graphics-layout.ts)`);
  if (info.width !== layout.width || info.height !== layout.height) {
    throw new Error(`the ${what} image is ${info.width}x${info.height}, its layout ${layout.width}x${layout.height}`);
  }
  return { image, mimeType: info.mimeType, layout };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const share = args.includes("--share");
  const unshare = args.includes("--unshare");
  const valued = new Set(["--shared-image", "--shared-layout", "--display-name"]);
  const positional = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
  const [orgId, imagePath, layoutPath] = positional;
  const sharedImagePath = flag(args, "--shared-image");
  const sharedLayoutPath = flag(args, "--shared-layout");
  const displayName = flag(args, "--display-name");
  if (!orgId || (!!imagePath !== !!layoutPath) || (!!sharedImagePath !== !!sharedLayoutPath) || (share && unshare)) {
    console.error(
      "usage: seed-club-graphics-template.ts <orgId> [<image> <layout.json>] [--shared-image <img> --shared-layout <json>] [--display-name <name>] [--share|--unshare] [--apply]",
    );
    process.exit(1);
  }

  const own = imagePath ? await readPair(imagePath, layoutPath!, "club's") : null;
  const variant = sharedImagePath ? await readPair(sharedImagePath, sharedLayoutPath!, "shared variant's") : null;
  if (variant && !variant.layout.brandArea) throw new Error("the shared variant's layout has no brandArea: where would the picking club's name go?");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as never);
  try {
    const org = await db.organisation.findUnique({ where: { id: orgId }, select: { id: true, name: true } });
    if (!org) throw new Error(`no organisation ${orgId}`);
    if (displayName !== undefined) {
      const problem = displayNameProblem(displayName, org.name);
      if (problem) throw new Error(`display name refused: ${problem}`);
    }
    const existing = await db.clubGraphicsTemplate.findUnique({ where: { orgId }, select: { orgId: true, kind: true, displayName: true } });
    if (!own && !existing) throw new Error(`organisation ${orgId} has no template yet: give its image and layout too`);
    if (share && !displayName && !existing?.displayName) throw new Error("sharing needs --display-name (other clubs see it)");

    const data = {
      ...(own ? { image: new Uint8Array(own.image), mimeType: own.mimeType, layout: own.layout, kind: "measured" } : {}),
      ...(variant ? { sharedImage: new Uint8Array(variant.image), sharedMimeType: variant.mimeType, sharedLayout: variant.layout } : {}),
      ...(displayName !== undefined ? { displayName: displayName.replace(/\s+/g, " ").trim() } : {}),
      ...(share ? { shared: true } : unshare ? { shared: false } : {}),
    };
    console.log(
      `${apply ? "APPLY" : "DRY RUN"}: org=${orgId} ${existing ? "update" : "create"}` +
        (own ? ` own=${own.mimeType} ${own.layout.width}x${own.layout.height} bytes=${own.image.length} rows=${own.layout.rows.length}` : " own=unchanged") +
        (variant ? ` variant=${variant.mimeType} bytes=${variant.image.length}` : " variant=unchanged") +
        (displayName !== undefined ? ` displayName="${data.displayName}"` : "") +
        (share ? " shared=true" : unshare ? " shared=false" : ""),
    );
    if (!apply) return;
    if (existing) await db.clubGraphicsTemplate.update({ where: { orgId }, data });
    else await db.clubGraphicsTemplate.create({ data: { orgId, ...(data as Required<Pick<typeof data, "image" | "mimeType" | "layout">> & typeof data) } });
    console.log("done");
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
