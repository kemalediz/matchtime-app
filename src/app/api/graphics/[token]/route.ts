/**
 * A club's list poster or team sheet as a PNG (2026-10-14).
 *
 *   GET /api/graphics/<token>
 *
 * Fetched by the Pi to post in a club's admin group, ready for the admins
 * to forward. The token (`src/lib/graphic-token.ts`) is the whole of the
 * access control: signed, naming one org, one match and one kind, and
 * short-lived. Anything else is a 404, the same answer whether the token
 * is forged, expired, for a match at another club, or for teams that do
 * not exist yet, so the route says nothing about what exists.
 *
 * The image carries first names, the club's name, the day, kickoff and
 * venue: no phone number, no rating (`src/lib/match-graphics.ts`).
 *
 * A club with its own graphics template (`ClubGraphicsTemplate`, e.g.
 * FNF's night stadium board) gets the graphic drawn on it, at the
 * template's size; any other club, or a graphic the template cannot hold
 * (a team sheet whose teams are not exactly its rows, a list longer than
 * its two columns), gets the default 1080 x 1350 design
 * (`src/lib/club-graphics-render.tsx`). Which one, and why, is said in
 * this log line only, never in the admin group.
 *
 * Since 2026-10-14 the design is the one the club chose on its Posters
 * card (`loadClubDesign`): its own template, an uploaded background, a
 * template another club shares (drawn with this club's name, its brand
 * area covered), or the default. A club that never chose keeps its own
 * template, so FNF's board is unchanged.
 *
 * Logged: ids, kind, the design and sizes only, never a name.
 */
import { verifyGraphicToken } from "@/lib/graphic-token";
import { loadGraphicData } from "@/lib/match-graphics";
import { loadClubDesign } from "@/lib/club-graphics-template";
import { renderClubGraphic } from "@/lib/club-graphics-render";

export const dynamic = "force-dynamic";

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const target = verifyGraphicToken(token);
  if (!target) return notFound();

  const data = await loadGraphicData(target);
  if (!data) return notFound();

  const chosen = await loadClubDesign(target.orgId);
  const { png, design } = await renderClubGraphic(data, chosen.template, { foreign: chosen.foreign });
  const count = data.kind === "list" ? data.players.length + data.reserves.length : data.teams[0].names.length + data.teams[1].names.length;
  const how = design.design === "default" ? `design=default reason=${design.reason}` : `design=${design.design} source=${chosen.source}`;
  console.log(`[graphics] ${target.kind} org=${target.orgId} match=${target.matchId} names=${count} ${how} bytes=${png.length}`);
  return new Response(new Uint8Array(png), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(png.length),
      "Cache-Control": "private, no-store",
    },
  });
}
