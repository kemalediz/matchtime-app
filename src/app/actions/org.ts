"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { createOrgSchema } from "@/lib/validations";
import { setCurrentOrgId } from "@/lib/org";
import { isLang, LANGS } from "@/lib/i18n/lang";
import { revalidatePath } from "next/cache";

export async function createOrganisation(formData: { name: string; slug: string }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const parsed = createOrgSchema.parse(formData);

  const existing = await db.organisation.findUnique({ where: { slug: parsed.slug } });
  if (existing) throw new Error("This URL is already taken. Try a different one.");

  const org = await db.organisation.create({
    data: {
      name: parsed.name,
      slug: parsed.slug,
      memberships: {
        create: {
          userId: session.user.id,
          role: "OWNER",
        },
      },
    },
  });

  await setCurrentOrgId(org.id);
  revalidatePath("/");
  return { orgId: org.id, slug: org.slug };
}

export async function joinOrganisation(inviteCode: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const org = await db.organisation.findUnique({ where: { inviteCode } });
  if (!org) throw new Error("Invalid invite link");

  const existing = await db.membership.findUnique({
    where: { userId_orgId: { userId: session.user.id, orgId: org.id } },
  });

  if (existing) {
    await setCurrentOrgId(org.id);
    return { orgId: org.id, alreadyMember: true };
  }

  await db.membership.create({
    data: {
      userId: session.user.id,
      orgId: org.id,
      role: "PLAYER",
    },
  });

  await setCurrentOrgId(org.id);
  revalidatePath("/");
  return { orgId: org.id, alreadyMember: false };
}

/**
 * Permanently delete an organisation and everything attached to it.
 *
 * Authorised for: superadmin OR the org's OWNER. The caller must
 * additionally pass the org's slug as a typed confirmation so a stray
 * click on the UI button can't fire this — frontend collects it via a
 * confirm dialog.
 *
 * Used by the delete button on /admin/organisations.
 */
export async function deleteOrganisation(orgId: string, confirmSlug: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, slug: true },
  });
  if (!org) throw new Error("Organisation not found");
  if (org.slug !== confirmSlug) {
    throw new Error("Slug confirmation didn't match");
  }

  const { isSuperadmin } = await import("@/lib/org");
  const superuser = await isSuperadmin(session.user.id);
  if (!superuser) {
    const membership = await db.membership.findUnique({
      where: { userId_orgId: { userId: session.user.id, orgId } },
      select: { role: true, leftAt: true },
    });
    if (!membership || membership.leftAt !== null || membership.role !== "OWNER") {
      throw new Error("Only the org owner can delete an organisation");
    }
  }

  const { wipeOrg } = await import("@/lib/wipe-org");
  await wipeOrg(orgId);

  // If the deleted org was the current one, clear the cookie so the
  // next page load doesn't try to load a missing org.
  const { getCurrentOrgId } = await import("@/lib/org");
  const currentId = await getCurrentOrgId();
  if (currentId === orgId) {
    const { cookies } = await import("next/headers");
    const cookieStore = await cookies();
    cookieStore.delete("orgId");
  }

  revalidatePath("/admin/organisations");
  revalidatePath("/");
}

/**
 * Shared guard for the two lifecycle actions below. Same bar as
 * `deleteOrganisation`: superadmin, or this org's OWNER. A plain ADMIN
 * runs the club week to week; deciding the club is over is not that job.
 */
async function requireOrgOwner(userId: string, orgId: string): Promise<void> {
  const { isSuperadmin } = await import("@/lib/org");
  if (await isSuperadmin(userId)) return;
  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { role: true, leftAt: true },
  });
  if (!membership || membership.leftAt !== null || membership.role !== "OWNER") {
    throw new Error("Only the org owner can change an organisation's lifecycle");
  }
}

/**
 * Declare an organisation DORMANT: the club has churned, the group is
 * gone, MatchTime stops acting on its own initiative for it. Sets the
 * single `dormantAt` timestamp and nothing else.
 *
 * This is the only writer of that field — it is declared by a human,
 * never inferred (the full argument, and the reason
 * `whatsappBotEnabled` is NOT this signal, is in
 * `src/lib/org-lifecycle.ts`).
 *
 * What it stops: the weekly `/api/cron/generate-matches` fixture roll.
 * What it does NOT do, on purpose:
 *  - it does not delete or anonymise anything (retaining the history is
 *    the point of dormancy existing at all — `deleteOrganisation` is
 *    the other door);
 *  - it does not touch `whatsappBotEnabled`, the feature flags, or any
 *    `Activity.isActive` — different axes, left where the operator put
 *    them, so waking the club up restores exactly what it had;
 *  - it does not retire fixtures ALREADY generated. Those are existing
 *    rows with attendance attached, and quietly cancelling them from
 *    here would be a surprise; `scripts/cancel-dormant-org-fixtures.ts`
 *    does that deliberately, with a dry run first.
 *
 * Guard: superadmin or OWNER, plus the org slug typed back — the same
 * two-step as deletion, because the consequence (no more fixtures) is
 * silent and would otherwise be discovered at kickoff.
 */
export async function markOrganisationDormant(orgId: string, confirmSlug: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, slug: true, dormantAt: true },
  });
  if (!org) throw new Error("Organisation not found");
  if (org.slug !== confirmSlug) throw new Error("Slug confirmation didn't match");

  await requireOrgOwner(session.user.id, orgId);

  // Idempotent, and deliberately NOT a re-stamp: `dormantAt` records
  // when the club actually went, which is what the cleanup script and
  // any later "when did we lose them?" both read. A second click must
  // not rewrite history.
  if (org.dormantAt !== null) return;

  await db.organisation.update({
    where: { id: orgId },
    data: { dormantAt: new Date() },
  });

  revalidatePath("/admin/organisations");
  revalidatePath("/admin");
}

/**
 * Wake a dormant organisation back up — a club that comes back next
 * season is the same club, with the same history. Clears `dormantAt`;
 * the next `/api/cron/generate-matches` run resumes its fixtures.
 *
 * No typed confirmation: this is the reversible direction. Fixtures
 * cancelled while it was dormant stay cancelled (restore them from
 * /admin/block-bookings, which already has a bulk restore).
 */
export async function reactivateOrganisation(orgId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { id: true, dormantAt: true },
  });
  if (!org) throw new Error("Organisation not found");

  await requireOrgOwner(session.user.id, orgId);

  if (org.dormantAt === null) return; // already live — nothing to undo

  await db.organisation.update({
    where: { id: orgId },
    data: { dormantAt: null },
  });

  revalidatePath("/admin/organisations");
  revalidatePath("/admin");
}

export async function switchOrg(orgId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  // Superadmins can switch to any org (even ones they're not a member of).
  const { isSuperadmin } = await import("@/lib/org");
  const superuser = await isSuperadmin(session.user.id);

  if (!superuser) {
    const membership = await db.membership.findUnique({
      where: { userId_orgId: { userId: session.user.id, orgId } },
    });
    if (!membership || membership.leftAt !== null) {
      throw new Error("Not a member of this organisation");
    }
  } else {
    const org = await db.organisation.findUnique({ where: { id: orgId } });
    if (!org) throw new Error("Organisation not found");
  }

  await setCurrentOrgId(orgId);
  revalidatePath("/");
}

/**
 * Toggle a single per-org feature module (Phase 1 — make the bot's
 * capabilities optional, per Kemal's promise to Amir's Thursday
 * group: MoM + ratings only). Admin-only. `paymentTracking` maps to
 * the pre-existing `paymentTrackingEnabled` column; the rest map to
 * `feature<Name>`.
 */
const FEATURE_COLUMN: Record<string, string> = {
  attendance: "featureAttendance",
  bench: "featureBench",
  teamBalancing: "featureTeamBalancing",
  momVoting: "featureMomVoting",
  playerRating: "featurePlayerRating",
  reminders: "featureReminders",
  statsQa: "featureStatsQa",
  paymentTracking: "paymentTrackingEnabled",
  paymentCollection: "paymentCollectionEnabled",
  payByBank: "payMethodPayByBank",
  payCard: "payMethodCard",
  payDirect: "payMethodDirect",
};

export async function setOrgFeature(
  orgId: string,
  feature: string,
  enabled: boolean,
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const { requireOrgAdmin } = await import("@/lib/org");
  await requireOrgAdmin(session.user.id, orgId);

  const column = FEATURE_COLUMN[feature];
  if (!column) throw new Error(`Unknown feature: ${feature}`);

  await db.organisation.update({
    where: { id: orgId },
    data: { [column]: enabled },
  });
  revalidatePath("/admin/settings");
  return { feature, enabled };
}

/**
 * Org-admin override for the two team DISPLAY labels (index 0 = the
 * canonical RED slot, index 1 = YELLOW). Empty strings mean "use the
 * default" for that slot — the resolver (`resolveTeamLabels`) falls
 * back per-slot to the Sport's labels, then "Red"/"Yellow". Both
 * empty clears the override entirely.
 */
export async function setOrgTeamLabels(
  orgId: string,
  redLabel: string,
  yellowLabel: string,
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const { requireOrgAdmin } = await import("@/lib/org");
  await requireOrgAdmin(session.user.id, orgId);

  // Strip chars that would break WhatsApp markdown (we post `*${label}*`)
  // and keep names short enough for poll options / lineup posts.
  const clean = (s: string) => s.replace(/[*\n\r`]/g, "").trim().slice(0, 24);
  const red = clean(redLabel);
  const yellow = clean(yellowLabel);
  if (red && yellow && red.toLowerCase() === yellow.toLowerCase()) {
    throw new Error("The two team names must be different");
  }

  const teamLabels = !red && !yellow ? [] : [red, yellow];
  await db.organisation.update({
    where: { id: orgId },
    data: { teamLabels },
  });
  revalidatePath("/admin/settings");
  return { teamLabels };
}

/**
 * The language the bot speaks to this group in (`Organisation.language`,
 * 2026-09-16). Validated against the languages the string table ships
 * (`LANGS`); anything else is refused rather than stored, so the column
 * can only ever hold a code `t()` resolves without falling back.
 *
 * Phase 0 of MDs/multi-language-design-2026-09-16.md: the setting round
 * trips, and NO consumer changes its behaviour on it yet. Setting "tr"
 * today changes nothing the group sees; the composers follow in Phase 2.
 */
export async function setOrgLanguage(orgId: string, language: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const { requireOrgAdmin } = await import("@/lib/org");
  await requireOrgAdmin(session.user.id, orgId);

  const code = language.trim().toLowerCase();
  if (!isLang(code)) {
    throw new Error(`Unsupported language: ${language} (one of ${LANGS.join(", ")})`);
  }

  await db.organisation.update({
    where: { id: orgId },
    data: { language: code },
  });
  revalidatePath("/admin/settings");
  return { language: code };
}
