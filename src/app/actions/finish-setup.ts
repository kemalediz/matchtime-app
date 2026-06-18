"use server";

/**
 * Apply the onboarding enrichment proposal to live records.
 *
 * The bot mines the group's chat history into a proposed roster (seed
 * ratings + positions), a list of phone-less members, and a best-guess
 * schedule — all stashed on OnboardingSession. The admin reviews/edits
 * these on /finish-setup/<sessionId> and clicks Apply, which lands here.
 *
 * Order matters: phones FIRST (they can MERGE duplicate User records,
 * which changes the surviving userId we must then seed/position), then
 * seeds, positions, schedule. The whole thing is idempotent — a second
 * call after the session is "applied" is a no-op.
 */
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireOrgAdmin } from "@/lib/org";
import { revalidatePath } from "next/cache";
import { seedFromAnalyzerRating } from "@/lib/seed-scale";
import { normalisePhone } from "@/lib/phone";
import { updatePlayerPhone } from "./players";

export interface ApplyEnrichmentInput {
  sessionId: string;
  players: { userId: string | null; name: string; position: string | null; seedRating: number | null }[];
  phones: { userId: string; phone: string }[];
  schedule: { dayOfWeek: number | null; time: string | null; venue: string | null; playersPerSide: number | null };
}

export async function applyEnrichment(
  input: ApplyEnrichmentInput,
): Promise<{ ok: true; applied: { seeds: number; positions: number; phones: number }; alreadyApplied?: boolean }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const onb = await db.onboardingSession.findUnique({ where: { id: input.sessionId } });
  if (!onb) throw new Error("Setup session not found");
  const orgId = onb.orgId;
  if (!orgId) throw new Error("This setup session has no organisation");
  await requireOrgAdmin(session.user.id, orgId);

  // Idempotency: once applied, never re-write.
  if (onb.enrichmentStatus === "applied") {
    return { ok: true, applied: { seeds: 0, positions: 0, phones: 0 }, alreadyApplied: true };
  }

  let seeds = 0;
  let positions = 0;
  let phones = 0;

  // ── 1. Phones first ──
  // updatePlayerPhone may merge a duplicate record. When the userId we
  // passed was the one DROPPED, it returns redirectToUserId pointing at the
  // surviving record — remap so subsequent seed/position writes target it.
  const remap = new Map<string, string>();
  for (const { userId, phone } of input.phones) {
    const norm = normalisePhone(phone);
    if (!norm) continue; // skip invalid phones — non-fatal
    try {
      const ret = await updatePlayerPhone(userId, orgId, norm);
      phones++;
      if (ret && "redirectToUserId" in ret && ret.redirectToUserId) {
        remap.set(userId, ret.redirectToUserId);
      }
    } catch {
      // skip a phone that genuinely conflicts with another player — non-fatal
    }
  }

  // ── 2. Resolve the org's activity + valid positions ──
  const activity = await db.activity.findFirst({
    where: { orgId },
    include: { sport: { select: { positions: true } } },
  });
  const validPositions = new Set(activity?.sport.positions ?? []);

  for (const player of input.players) {
    const uid = player.userId ? remap.get(player.userId) ?? player.userId : null;
    if (!uid) continue;

    // ── 3. Seed ratings ──
    if (player.seedRating != null) {
      const v = seedFromAnalyzerRating(player.seedRating);
      if (v != null) {
        await db.user.update({ where: { id: uid }, data: { seedRating: v } });
        seeds++;
      }
    }

    // ── 4. Positions ──
    if (activity && player.position && validPositions.has(player.position)) {
      await db.playerActivityPosition.upsert({
        where: { userId_activityId: { userId: uid, activityId: activity.id } },
        create: { userId: uid, activityId: activity.id, positions: [player.position] },
        update: { positions: [player.position] },
      });
      positions++;
    }
  }

  // ── 5. Schedule / format ──
  if (activity) {
    const data: { dayOfWeek?: number; time?: string; venue?: string } = {};
    if (input.schedule.dayOfWeek != null) data.dayOfWeek = input.schedule.dayOfWeek;
    if (input.schedule.time != null) data.time = input.schedule.time;
    if (input.schedule.venue != null) data.venue = input.schedule.venue;
    if (Object.keys(data).length > 0) {
      await db.activity.update({ where: { id: activity.id }, data });
    }

    if (input.schedule.playersPerSide != null) {
      const match =
        (await db.match.findFirst({
          where: { activityId: activity.id, status: "UPCOMING" },
          orderBy: { date: "asc" },
        })) ??
        (await db.match.findFirst({
          where: { activityId: activity.id },
          orderBy: { date: "desc" },
        }));
      if (match) {
        await db.match.update({
          where: { id: match.id },
          data: { maxPlayers: input.schedule.playersPerSide * 2 },
        });
      }
    }
  }

  // ── 6. Mark done ──
  await db.onboardingSession.update({
    where: { id: input.sessionId },
    data: { enrichmentStatus: "applied", enrichmentAppliedAt: new Date() },
  });

  revalidatePath("/admin");
  revalidatePath("/admin/players");
  revalidatePath("/admin/players/positions");
  revalidatePath("/admin/players/phones");

  return { ok: true, applied: { seeds, positions, phones } };
}
