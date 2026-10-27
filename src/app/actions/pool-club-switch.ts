"use server";

/**
 * The platform owner switches the MatchTime player pool on or off for one
 * club (2026-10-27, /admin/clubs, "Player pool").
 *
 * SUPERADMIN ONLY, checked here for real, the same guard as the page's
 * other owner actions: the switch is only on a page that 404s for everybody
 * else, but a server action is a public endpoint. The write and what OFF
 * closes are `setClubPlayerPool` (src/lib/pool/club-switch.ts).
 *
 * "use server" modules may export async functions only.
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { isSuperadmin } from "@/lib/org";
import { setClubPlayerPool } from "@/lib/pool/club-switch";

export interface ClubPoolSwitchActionResult {
  ok: boolean;
  message: string;
}

export async function setClubPlayerPoolAction(orgId: string, on: boolean): Promise<ClubPoolSwitchActionResult> {
  const session = await auth();
  if (!session?.user?.id || !(await isSuperadmin(session.user.id))) throw new Error("Not allowed");
  if (typeof orgId !== "string" || typeof on !== "boolean") throw new Error("Bad request");

  const r = await setClubPlayerPool(orgId, on);
  revalidatePath("/admin/clubs");
  revalidatePath("/admin/settings");
  if (!r.ok) return { ok: false, message: "That club no longer exists." };
  if (r.on) {
    return {
      ok: true,
      message: r.autoAsk
        ? "Player pool on. The club's admin had already turned automatic asking on, so it asks the pool automatically."
        : "Player pool on. Automatic asking stays off until the club's admin turns it on.",
    };
  }
  const closed = r.closedAsks === 0 ? "" : ` ${r.closedAsks} open pool ask${r.closedAsks === 1 ? "" : "s"} closed.`;
  return { ok: true, message: `Player pool off.${closed}` };
}
