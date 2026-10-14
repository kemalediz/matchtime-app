/**
 * A POSTERS CARD PREVIEW AS A PNG (2026-10-14).
 *
 *   GET /api/org/graphics/preview?kind=list|teams[&design=<gallery id>]
 *
 * Session-authenticated (the card's <img> sends the owner's cookie), owner
 * or admin of the club only; a player gets 403. The club's list poster or
 * team sheet for its next match, or the marked sample (`graphics-preview.ts`;
 * the `X-Graphic-Sample: 1` header says so), drawn in the design in force,
 * or in `design` when the gallery asks for one of its options. A design
 * this club may not use (another club's private template, junk) is 404.
 *
 * Logged: ids, kind, design, sample and size; never a name.
 */
import { clubGraphicsAccess } from "@/lib/club-graphics-access";
import { loadClubDesign, loadClubDesignById } from "@/lib/club-graphics-template";
import { loadPreviewGraphic } from "@/lib/graphics-preview";
import { renderClubGraphic } from "@/lib/club-graphics-render";

export const dynamic = "force-dynamic";

const plain = (status: number, text: string) => new Response(text, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: Request) {
  const access = await clubGraphicsAccess();
  if (!access.ok) return plain(access.status, "Not allowed");

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  if (kind !== "list" && kind !== "teams") return plain(400, "kind must be list or teams");
  const id = url.searchParams.get("design");

  const design = id ? await loadClubDesignById(access.orgId, id) : await loadClubDesign(access.orgId);
  if (!design) return plain(404, "Not found");
  // A sample is sized to a measured template, so the template is what is seen.
  const fit = design.template?.kind === "measured" ? { rows: design.template.layout.rows.length } : undefined;
  const preview = await loadPreviewGraphic(access.orgId, kind, new Date(), fit);
  if (!preview) return plain(404, "Not found");

  const { png, design: drawn } = await renderClubGraphic(preview.data, design.template, { foreign: design.foreign });
  console.log(
    `[graphics] preview ${kind} org=${access.orgId} source=${design.source} drawn=${drawn.design} sample=${preview.sample ? 1 : 0} bytes=${png.length}`,
  );
  return new Response(new Uint8Array(png), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(png.length),
      "Cache-Control": "private, no-store",
      "X-Graphic-Sample": preview.sample ? "1" : "0",
    },
  });
}
