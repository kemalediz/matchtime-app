"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireOrgAdmin } from "@/lib/org";
import { registerAttendance, cancelAttendance } from "@/lib/attendance";
import { revalidatePath } from "next/cache";

/**
 * #1 — "never silently drop": the admin-side surface for attendance
 * messages the bot received but couldn't tie to a player (ambiguous /
 * unknown sender). Pairs with the real-time group nudge in the analyze
 * route. Backed entirely by AnalyzedMessage (authorUserId = null,
 * intent attendance-relevant) — no new table.
 */

const ATTENDANCE_INTENTS = ["in", "out", "replacement_request"];

const norm = (s: string) =>
  s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export interface UnresolvedGroup {
  /** Normalised pushname key (what an alias would store). */
  key: string;
  /** Display pushname (most recent raw form). */
  pushname: string;
  count: number;
  /** Most recent attendance-relevant intent seen for this pushname. */
  lastIntent: string;
  lastBody: string;
  lastAt: string;
  sampleBodies: string[];
}

/**
 * List unresolved attendance-relevant messages for the current org,
 * grouped by normalised pushname, newest first. Only the last 21 days
 * (older than that the match has long passed — not actionable).
 */
export async function listUnresolved(orgId: string): Promise<UnresolvedGroup[]> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);

  const since = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
  const rows = await db.analyzedMessage.findMany({
    where: {
      orgId,
      authorUserId: null,
      authorName: { not: null },
      intent: { in: ATTENDANCE_INTENTS },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
    select: { authorName: true, intent: true, body: true, createdAt: true },
  });

  const byKey = new Map<string, UnresolvedGroup>();
  for (const r of rows) {
    const name = (r.authorName ?? "").trim();
    if (!name) continue;
    const key = norm(name);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        pushname: name,
        count: 1,
        lastIntent: r.intent ?? "?",
        lastBody: (r.body ?? "").slice(0, 160),
        lastAt: r.createdAt.toISOString(),
        sampleBodies: [(r.body ?? "").slice(0, 160)],
      });
    } else {
      existing.count += 1;
      if (existing.sampleBodies.length < 4) {
        existing.sampleBodies.push((r.body ?? "").slice(0, 160));
      }
    }
  }
  return [...byKey.values()].sort(
    (a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime(),
  );
}

/** Lightweight count for the subnav badge. */
export async function unresolvedCount(orgId: string): Promise<number> {
  const session = await auth();
  if (!session?.user?.id) return 0;
  const since = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
  const rows = await db.analyzedMessage.findMany({
    where: {
      orgId,
      authorUserId: null,
      authorName: { not: null },
      intent: { in: ATTENDANCE_INTENTS },
      createdAt: { gte: since },
    },
    select: { authorName: true },
  });
  return new Set(rows.map((r) => norm(r.authorName ?? "")).filter(Boolean)).size;
}

/**
 * Link an unresolved pushname to a player. This is the permanent fix
 * for that collision:
 *   1. Create a UserAlias (norm(pushname) → user) so EVERY future
 *      message with that pushname resolves — even on ambiguous fuzzy
 *      (the resolver consults UserAlias before bailing).
 *   2. Optionally replay the most recent attendance intent NOW against
 *      the soonest open match, so the drop/IN that was lost actually
 *      lands (the whole point — recover the silently-dropped action).
 */
export async function assignUnresolvedToPlayer(args: {
  orgId: string;
  pushname: string;
  userId: string;
  applyLatestIntent: boolean;
}): Promise<{ aliasCreated: boolean; applied: string | null }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, args.orgId);

  const key = norm(args.pushname);
  if (key.length < 2) throw new Error("Pushname too short to alias");

  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId: args.userId, orgId: args.orgId } },
    select: { userId: true },
  });
  if (!membership) throw new Error("Player is not a member of this organisation");

  // 1. Alias (idempotent; refuse to steal another player's alias).
  const existing = await db.userAlias.findUnique({
    where: { orgId_alias: { orgId: args.orgId, alias: key } },
    select: { userId: true },
  });
  let aliasCreated = false;
  if (existing && existing.userId !== args.userId) {
    throw new Error(`"${key}" is already linked to a different player`);
  }
  if (!existing) {
    await db.userAlias.create({
      data: { orgId: args.orgId, userId: args.userId, alias: key, source: "manual" },
    });
    aliasCreated = true;
  }

  // 2. Optionally replay the most recent attendance intent.
  let applied: string | null = null;
  if (args.applyLatestIntent) {
    const since = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
    const all = await db.analyzedMessage.findMany({
      where: {
        orgId: args.orgId,
        authorUserId: null,
        intent: { in: ATTENDANCE_INTENTS },
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
      select: { authorName: true, intent: true },
    });
    const latest = all.find((r) => norm(r.authorName ?? "") === key);
    if (latest) {
      const match = await db.match.findFirst({
        where: {
          activity: { orgId: args.orgId },
          status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
        },
        orderBy: { date: "asc" },
        select: { id: true },
      });
      if (match) {
        try {
          if (latest.intent === "out" || latest.intent === "replacement_request") {
            await cancelAttendance(args.userId, match.id);
            applied = "OUT";
          } else if (latest.intent === "in") {
            const r = await registerAttendance(args.userId, match.id);
            applied = r.status; // CONFIRMED | BENCH
          }
        } catch (err) {
          // Non-fatal: the alias still landed (the durable fix). The
          // admin can adjust attendance manually if the replay failed
          // (e.g. match already completed).
          console.error("[unresolved] replay failed:", err);
        }
      }
    }
  }

  revalidatePath("/admin/unresolved");
  revalidatePath("/admin/players");
  return { aliasCreated, applied };
}
