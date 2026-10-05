"use server";

/**
 * Monthly squad, slice 2 (MDs/monthly-squad-plan-2026-10-05.md): the
 * server actions behind /admin/settings "Monthly squad" and /admin/months.
 * OWNER and ADMIN only (D6: the organiser switches the mode on; nothing
 * switches it for them).
 *
 * Validation refusals come back as `{ ok: false, error }` for the page to
 * put into words: Next replaces a thrown message with a generic one in
 * production. Not being signed in, or not being an admin, still throws.
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { readListForSeed, startMonth, type ReadListError, type StartMonthError } from "@/lib/squad-month";
import {
  normaliseCreditRule,
  normaliseSquadMode,
  prepareMonthlySquadPatch,
  type MonthCreditRule,
  type MonthlySquadPatch,
  type MonthlySquadSettingError,
  type MonthSeedInput,
  type SeedDraftRow,
  type SeedDraftUnmatched,
  type SquadMode,
} from "@/lib/squad-month-rules";

async function requireAdmin(orgId: string): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const { requireOrgAdmin } = await import("@/lib/org");
  await requireOrgAdmin(session.user.id, orgId);
  return session.user.id;
}

export interface MonthlySquadSettings {
  squadMode: SquadMode;
  /** After the save: a switch to monthly turns the rolling squad off. */
  rollingSquad: boolean;
  paygPricePence: number | null;
  monthListOpensDaysBefore: number;
  monthCreditRule: MonthCreditRule;
  paymentInstructions: string | null;
}

/**
 * Save one or more "Monthly squad" settings. Switching to monthly also
 * turns the rolling squad off (the month replaces it, plan 5.1); switching
 * back leaves it off for the organiser to turn on again.
 */
export async function setMonthlySquad(
  orgId: string,
  patch: MonthlySquadPatch,
): Promise<({ ok: true } & MonthlySquadSettings) | { ok: false; error: MonthlySquadSettingError }> {
  await requireAdmin(orgId);
  const prepared = prepareMonthlySquadPatch(patch);
  if (!prepared.ok) return prepared;

  const row = await db.organisation.update({
    where: { id: orgId },
    // F3: the organiser's own choice; the learned setup never overrides it.
    data: { ...prepared.data, settingsSetByOrganiser: { push: prepared.keys } },
    select: {
      squadMode: true,
      rollingSquadEnabled: true,
      paygPricePence: true,
      monthListOpensDaysBefore: true,
      monthCreditRule: true,
      paymentInstructions: true,
    },
  });
  revalidatePath("/admin/settings");
  revalidatePath("/admin/months");
  return {
    ok: true,
    squadMode: normaliseSquadMode(row.squadMode),
    rollingSquad: row.rollingSquadEnabled,
    paygPricePence: row.paygPricePence,
    monthListOpensDaysBefore: row.monthListOpensDaysBefore,
    monthCreditRule: normaliseCreditRule(row.monthCreditRule),
    paymentInstructions: row.paymentInstructions,
  };
}

/**
 * Start the current month, already under way, from the organiser's list
 * (plan 4.5): the regulars, who has paid and how much, the PAYG players
 * and the credits carried in. `input.rows` come from ticks on the page
 * ("seed-tick") or from a pasted list read by `readMonthList` and checked
 * by the organiser ("seed-list").
 */
export async function startCurrentMonth(
  orgId: string,
  input: MonthSeedInput,
): Promise<{ ok: true; monthId: string } | { ok: false; error: StartMonthError }> {
  const userId = await requireAdmin(orgId);
  const res = await startMonth(orgId, userId, input, new Date());
  if (res.ok) revalidatePath("/admin/months");
  return res;
}

/**
 * Read a pasted list into a draft for the page (plan 4.5 and 6.1): the
 * names matched to the club's players, with "says paid" and PAYG as the
 * list writes them. Read only. A paid mark on a list is never a
 * confirmation; the organiser checks the draft and starts the month with
 * `startCurrentMonth`.
 */
export async function readMonthList(
  orgId: string,
  text: string,
): Promise<
  | { ok: true; rows: SeedDraftRow[]; unmatched: SeedDraftUnmatched[]; monthMismatch: boolean }
  | { ok: false; error: ReadListError }
> {
  await requireAdmin(orgId);
  return readListForSeed(orgId, text, new Date());
}
