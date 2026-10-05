"use server";

import { normaliseBenchPickFallback, normaliseBenchPickMode } from "@/lib/squad-capacity";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { createOrgSchema } from "@/lib/validations";
import { setCurrentOrgId } from "@/lib/org";
import { isLang, LANGS, normaliseLang } from "@/lib/i18n/lang";
import { t } from "@/lib/i18n/t";
import { selfJoinEnabledForRequest } from "@/lib/self-join-flag";
import { createSelfJoinClub, type SelfJoinClubInput, type SelfJoinRefusal } from "@/lib/self-join-club";
import { announcePaymentsLiveIfJustLive, readPaymentLiveState } from "@/lib/payments-live-announce";
import { revalidatePath } from "next/cache";
import {
  hasWeeklyDeadlinesPatch,
  prepareWeeklyDeadlinesPatch,
  weeklyDeadlinesView,
  type WeeklyDeadlinesData,
  type WeeklyDeadlinesPatch,
} from "@/lib/weekly-deadlines-settings";
import { saveAdminChannelChoice, type SaveAdminChannelResult } from "@/lib/admin-channel";

/**
 * Today's club creation (/create-org with SELF_JOIN_ENABLED off).
 *
 * With self-join ON it refuses: a club made here would be approved by
 * the column default, around the one-club and daily caps. The setup form
 * posts to `createSelfJoinClubAction` instead.
 */
export async function createOrganisation(formData: { name: string; slug: string }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if (await selfJoinEnabledForRequest()) throw new Error("Please use the club setup form.");

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

/**
 * Self-join slice 4: create a DRAFT club with its weekly game
 * (plan section 5.1, decision 2). Only with SELF_JOIN_ENABLED on.
 *
 * Returns rather than throws: Next replaces a thrown server-action
 * message with a generic one in production, and the organiser has to
 * read why they were refused, in the language they picked.
 */
export async function createSelfJoinClubAction(
  input: SelfJoinClubInput,
): Promise<{ ok: true; orgId: string } | { ok: false; reason: SelfJoinRefusal | "off" | "signed-out"; error: string }> {
  const s = t(normaliseLang(input?.language));
  const session = await auth();
  if (!session?.user?.id) return { ok: false, reason: "signed-out", error: s.sj_err_generic };
  if (!(await selfJoinEnabledForRequest())) return { ok: false, reason: "off", error: s.sj_err_generic };

  const res = await createSelfJoinClub(session.user.id, input, new Date());
  if (!res.ok) {
    const error = {
      invalid: s.sj_err_invalid,
      "verify-phone": s.sj_err_verify_phone,
      "one-club": s.sj_err_one_club,
      "site-cap": s.sj_err_site_cap,
    }[res.reason];
    return { ok: false, reason: res.reason, error };
  }
  await setCurrentOrgId(res.orgId);
  revalidatePath("/");
  revalidatePath("/admin");
  return { ok: true, orgId: res.orgId };
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
  badgeAnnouncements: "featureBadgeAnnouncements",
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

  // Switching payment collection ON may be the second of the two
  // switches that make it live; the group is then told how it works,
  // once (`lib/payments-live-announce.ts`, 2026-09-30). Read BEFORE the
  // write. A failed read counts as "already live": say nothing rather
  // than risk a repeat.
  const announcing = feature === "paymentCollection" && enabled;
  const wasLive = announcing ? await readPaymentLiveState(orgId).catch(() => true) : true;

  await db.organisation.update({
    where: { id: orgId },
    // F3: the organiser's own choice; the learned setup never overrides it.
    data: { [column]: enabled, settingsSetByOrganiser: { push: feature } },
  });
  if (announcing) {
    await Promise.resolve(announcePaymentsLiveIfJustLive(orgId, { wasLive })).catch((err) =>
      console.error("[org] payments-live announcement failed:", err),
    );
  }
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
    data: { language: code, settingsSetByOrganiser: { push: "language" } },
  });
  revalidatePath("/admin/settings");
  return { language: code };
}

/**
 * The "Weekly routine" settings on /admin/settings (2026-09-30), plan
 * section 5 of MDs/friday-group-features-plan-2026-09-30.md. OWNER/ADMIN
 * only. Every weekly-routine setting goes through this ONE action as a
 * patch, so slices 2 (who fills an open place) and 3 (weekly deadlines)
 * add a key here rather than a new action. Each key is validated and a
 * patch with nothing valid in it is refused, never silently ignored.
 *
 * Slice 1: `rollingSquad` (`Organisation.rollingSquadEnabled`).
 * Slice 3: `dropOutDeadline` and `listPublish` (day + time, or null to
 * clear), validated in `weekly-deadlines-settings.ts`; a refusal comes
 * back as `{ error }` for the page to show, and nothing is written.
 * Slice 2a: `adminChannel` ("Admin messages go to"), saved through
 * `saveAdminChannelChoice`, which refuses "admin-group" until a group is
 * linked ("needs-link") and a chosen person who is not an admin with a
 * phone. Linking and unlinking the group are flows, not settings, and have
 * their own actions (src/app/actions/admin-channel.ts).
 */
export interface WeeklyRoutinePatch extends WeeklyDeadlinesPatch {
  rollingSquad?: boolean;
  /** Slice 2b: who fills an open place. */
  benchPickMode?: "first-come" | "organiser";
  /** Slice 2b: when nobody picks in time. */
  benchPickFallback?: "bench-offer" | "leave-empty";
  adminChannel?: { mode: string; userId: string | null };
}

export async function setWeeklyRoutine(orgId: string, patch: WeeklyRoutinePatch) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const { requireOrgAdmin } = await import("@/lib/org");
  await requireOrgAdmin(session.user.id, orgId);

  const data: { rollingSquadEnabled?: boolean; benchPickMode?: string; benchPickFallback?: string } & WeeklyDeadlinesData = {};
  if (patch && "rollingSquad" in patch) {
    if (typeof patch.rollingSquad !== "boolean") throw new Error("rollingSquad must be true or false");
    data.rollingSquadEnabled = patch.rollingSquad;
  }
  if (patch && "benchPickMode" in patch) {
    if (patch.benchPickMode !== "first-come" && patch.benchPickMode !== "organiser") {
      throw new Error('benchPickMode must be "first-come" or "organiser"');
    }
    data.benchPickMode = patch.benchPickMode;
  }
  if (patch && "benchPickFallback" in patch) {
    if (patch.benchPickFallback !== "bench-offer" && patch.benchPickFallback !== "leave-empty") {
      throw new Error('benchPickFallback must be "bench-offer" or "leave-empty"');
    }
    data.benchPickFallback = patch.benchPickFallback;
  }
  if (hasWeeklyDeadlinesPatch(patch)) {
    const deadlines = await prepareWeeklyDeadlinesPatch(orgId, patch);
    if (deadlines.error) return { ok: false as const, error: deadlines.error };
    Object.assign(data, deadlines.data);
  }
  let adminChannel: { mode: string; userId: string | null } | null = null;
  if (patch && "adminChannel" in patch) {
    const a = patch.adminChannel;
    if (!a || typeof a !== "object" || typeof a.mode !== "string" || (a.userId !== null && typeof a.userId !== "string")) {
      throw new Error("adminChannel must be { mode, userId }");
    }
    adminChannel = { mode: a.mode, userId: a.userId };
  }
  if (Object.keys(data).length === 0 && !adminChannel) throw new Error("Nothing to change");

  const select = {
    rollingSquadEnabled: true,
    benchPickMode: true,
    benchPickFallback: true,
    dropOutDeadlineDay: true,
    dropOutDeadlineTime: true,
    listPublishDay: true,
    listPublishTime: true,
  } as const;
  // A patch with only `adminChannel` writes nothing here; the row is read
  // so the answer has the same shape either way.
  // F3: the keys the organiser saved; the learned setup never overrides them.
  const setKeys = Object.keys(patch ?? {}).filter((k) =>
    ["rollingSquad", "benchPickMode", "benchPickFallback", "dropOutDeadline", "listPublish"].includes(k),
  );
  const row =
    Object.keys(data).length > 0
      ? await db.organisation.update({
          where: { id: orgId },
          data: { ...data, ...(setKeys.length > 0 ? { settingsSetByOrganiser: { push: setKeys } } : {}) },
          select,
        })
      : await db.organisation.findUniqueOrThrow({ where: { id: orgId }, select });
  const saved: { adminChannel?: SaveAdminChannelResult } = {};
  if (adminChannel) saved.adminChannel = await saveAdminChannelChoice(orgId, adminChannel.mode, adminChannel.userId);
  revalidatePath("/admin/settings");
  return {
    ok: true as const,
    rollingSquad: row.rollingSquadEnabled,
    benchPickMode: normaliseBenchPickMode(row.benchPickMode),
    benchPickFallback: normaliseBenchPickFallback(row.benchPickFallback),
    ...weeklyDeadlinesView(row),
    ...saved,
  };
}
