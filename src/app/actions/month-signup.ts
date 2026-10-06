"use server";

/**
 * Monthly squad, slice 3 (MDs/monthly-squad-plan-2026-10-05.md, 4.1 and
 * 9.2): the server actions behind the player's own sign-up page (/month)
 * and the member buttons on /admin/months.
 *
 * Both end in `applySignup` (`lib/month-signup.ts`), which refuses a club
 * on "weekly", a closed month and anybody who is not a current player of
 * the club, and writes under the club-month's lock. Refusals come back as
 * `{ ok: false, error }` for the page to put into words.
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { applySignup, type ApplySignupResult } from "@/lib/month-signup";
import type { SignupChoice } from "@/lib/month-signup-rules";

const CHOICES: readonly SignupChoice[] = ["in", "payg", "out"];

function cleanDays(days: unknown): number[] {
  if (!Array.isArray(days)) return [];
  return [...new Set(days.filter((d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 31))].slice(0, 10);
}

/** A player's own choice for a month: in, pay as you go (on these days of
 *  the month, or none), or out. Only ever for the signed-in player. */
export async function signUpForMonth(monthId: string, choice: SignupChoice, days: number[] = []): Promise<ApplySignupResult> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if (typeof monthId !== "string" || !CHOICES.includes(choice)) return { ok: false, error: "not-found" };
  const res = await applySignup({
    monthId,
    userId: session.user.id,
    choice,
    days: choice === "payg" ? cleanDays(days) : [],
    source: "page",
    actorUserId: session.user.id,
  });
  revalidatePath("/month");
  return res;
}

/**
 * An organiser changes one member of a month on /admin/months: make them
 * a regular (past the cap if need be: the organiser decides, plan 4.1),
 * move them to PAYG, or take them off the month. OWNER and ADMIN only.
 * Nothing here writes a paid field, and no row is deleted.
 */
export async function setMonthMember(
  orgId: string,
  monthId: string,
  userId: string,
  to: "regular" | "payg" | "out",
): Promise<ApplySignupResult> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const { requireOrgAdmin } = await import("@/lib/org");
  await requireOrgAdmin(session.user.id, orgId);
  if (to !== "regular" && to !== "payg" && to !== "out") return { ok: false, error: "not-found" };
  // The month must be this club's: the id alone is not trusted.
  const month = await db.squadMonth.findFirst({ where: { id: monthId, orgId }, select: { id: true } });
  if (!month) return { ok: false, error: "not-found" };
  const res = await applySignup({
    monthId,
    userId,
    choice: to === "regular" ? "in" : to,
    source: "admin",
    actorUserId: session.user.id,
    byOrganiser: true,
  });
  revalidatePath("/admin/months");
  return res;
}
