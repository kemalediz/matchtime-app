"use server";

/**
 * The "Bring a friend" card's data (pool slice G1): the SIGNED-IN person's
 * own share link and message, through `src/lib/pool/growth.ts`. Nothing in
 * the request names whose. Null when he has no live pool profile.
 */
import { auth } from "@/lib/auth";
import { loadPoolShare, type PoolShareView } from "@/lib/pool/growth";

export async function loadPoolShareAction(): Promise<PoolShareView | null> {
  const userId = (await auth())?.user?.id;
  if (!userId) return null;
  return loadPoolShare(userId);
}
