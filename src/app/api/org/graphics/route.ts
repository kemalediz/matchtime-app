/**
 * THE POSTERS CARD'S STATE (2026-10-14), for /admin/settings.
 *
 *   GET /api/org/graphics
 *
 * Owner or admin of the club the request operates in (and the platform
 * superadmin); anyone else 403 (`club-graphics-access.ts`), and the card
 * is not shown. Returns the gallery (MatchTime, the club's own design if
 * any, the designs other clubs share, by display name only), which one is
 * in force, whether the club's own design is an upload it can remove, and
 * whether the previews will show sample names. The pictures themselves
 * come from ./preview.
 */
import { NextResponse } from "next/server";
import { clubGraphicsAccess } from "@/lib/club-graphics-access";
import { loadClubDesignState } from "@/lib/club-graphics-template";
import { loadPreviewGraphic } from "@/lib/graphics-preview";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await clubGraphicsAccess();
  if (!access.ok) return NextResponse.json({ error: "Not allowed" }, { status: access.status });

  const now = new Date();
  const [state, list, teams] = await Promise.all([
    loadClubDesignState(access.orgId),
    loadPreviewGraphic(access.orgId, "list", now),
    loadPreviewGraphic(access.orgId, "teams", now),
  ]);
  return NextResponse.json(
    {
      current: state.current,
      options: state.options,
      own: state.own,
      removable: state.own?.kind === "background",
      sample: { list: list?.sample ?? true, teams: teams?.sample ?? true },
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
