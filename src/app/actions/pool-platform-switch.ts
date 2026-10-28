"use server";

/**
 * The platform owner's ONE "Player pool" switch on /admin/clubs
 * (2026-10-28, decision log P.1): the MatchTime player pool for every club,
 * the kill switch. On, each club's owners and admins see the "Player pool"
 * card in their settings and switch it on for their club; off, the pool is
 * closed for every club and every open ask is closed.
 *
 * SUPERADMIN ONLY, checked here for real: the switch is only on a page that
 * 404s for everybody else, but a server action is a public endpoint. The
 * write and what OFF closes are `setPoolPlatformSwitch`
 * (src/lib/pool/platform-switch.ts).
 *
 * "use server" modules may export async functions only.
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { isSuperadmin } from "@/lib/org";
import { setPoolPlatformSwitch } from "@/lib/pool/platform-switch";

export interface PoolPlatformSwitchActionResult {
  ok: boolean;
  message: string;
}

export async function setPoolPlatformSwitchAction(on: boolean): Promise<PoolPlatformSwitchActionResult> {
  const session = await auth();
  if (!session?.user?.id || !(await isSuperadmin(session.user.id))) throw new Error("Not allowed");
  if (typeof on !== "boolean") throw new Error("Bad request");

  const r = await setPoolPlatformSwitch(on, session.user.id);
  revalidatePath("/admin/clubs");
  revalidatePath("/admin/settings");
  if (r.on && r.forcedOff) {
    return { ok: true, message: "Switched on, but POOL_OFFERS_ENABLED forces the pool off in this deployment. Remove it, or set it to 1, and redeploy." };
  }
  if (r.on) return { ok: true, message: "Player pool on for every club. Each club's admins can now switch it on in their settings." };
  const closed = r.closedAsks === 0 ? "" : ` ${r.closedAsks} open pool ask${r.closedAsks === 1 ? "" : "s"} closed.`;
  return { ok: true, message: `Player pool off for every club.${closed}` };
}
