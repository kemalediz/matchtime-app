import { auth } from "@/lib/auth";
import { ORDINARY_MEMBER_WHERE } from "@/lib/guest-membership";
import { normaliseBenchPickFallback, normaliseBenchPickMode } from "@/lib/squad-capacity";
import { db } from "@/lib/db";
import { getUserOrg } from "@/lib/org";
import { resolveTeamLabels } from "@/lib/team-labels";
import { normaliseLang } from "@/lib/i18n/lang";
import { seesAdminFields } from "@/lib/admin-view";
import { weeklyDeadlinesView } from "@/lib/weekly-deadlines-settings";
import { loadBillingCard } from "@/lib/club-billing";
import { billingUiEnabledForRequest } from "@/lib/billing-flag";
import { normaliseCreditRule, normaliseSquadMode } from "@/lib/squad-month-rules";
import { loadClubSetupView } from "@/lib/club-setup";
import { normaliseListAnnouncer } from "@/lib/list-announcer";
import { normaliseMomChooser } from "@/lib/mom-chooser";
import { NextResponse } from "next/server";
import type { Organisation } from "@/generated/prisma/client";
import type { ClubRowFacts } from "@/lib/club-summary/types";
import { clubRowFactsOf } from "@/lib/club-row-facts";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const membership = await getUserOrg(session.user.id);
  if (!membership) {
    return NextResponse.json({ error: "No organisation" }, { status: 404 });
  }

  const org = await db.organisation.findUnique({
    where: { id: membership.orgId },
    include: { _count: { select: { memberships: true } } },
  });

  if (!org) {
    return NextResponse.json({ error: "Organisation not found" }, { status: 404 });
  }

  // The invite code, WhatsApp group id, Stripe status, money collector
  // and member list are for the club's OWNER/ADMIN (and the platform
  // superadmin). Every caller is an admin page; a plain member calling
  // this directly gets the club's name, language and features only.
  const isAdmin = await seesAdminFields(session.user.id, membership.role);

  // Members eligible to be the money collector — must have a phone (so they
  // can receive the "how much?" + confirm-direct DMs). Used by the collector
  // picker in the Payments section.
  const members = !isAdmin ? [] : await db.membership.findMany({
    // Never a partner club's guest (cross-club ask, review H1).
    where: { orgId: org.id, leftAt: null, ...ORDINARY_MEMBER_WHERE, user: { phoneNumber: { not: null } } },
    select: { user: { select: { id: true, name: true } } },
    orderBy: { user: { name: "asc" } },
  });

  // Default team labels (what the org falls back to when no override is
  // set) — from the org's first sport, then "Red"/"Yellow". Drives the
  // placeholders in the Team names editor.
  const firstSport = await db.sport.findFirst({
    where: { orgId: org.id },
    select: { teamLabels: true },
    orderBy: { createdAt: "asc" },
  });
  const defaultTeamLabels = resolveTeamLabels(null, null, firstSport, org.language);

  // The club's facts (club summary, slice A4), else, when they cannot be
  // built, today's reads of the same row.
  const club = clubRowFactsOf(org, "org-settings");
  const f = club ? settingsFactsOf(club) : settingsFactsOfRow(org);

  const publicView = {
    id: org.id,
    name: org.name,
    slug: org.slug,
    memberCount: org._count.memberships,
    // Team-name override (raw — empty array / empty strings mean
    // "use the defaults") + the defaults themselves for placeholders.
    teamLabels: f.teamLabels,
    defaultTeamLabels,
    // The language the bot speaks to this group in (Phase 0 of the
    // multi-language design: read-and-round-trip only, no consumer yet).
    language: normaliseLang(org.language),
    features: f.features,
  };
  if (!isAdmin) return NextResponse.json(publicView);

  // Club fee billing (slice B2): the billing card, for OWNER and ADMIN
  // only. Null with BILLING_ENABLED off and for an exempt club, so
  // Sutton FC and every club before billing see nothing new.
  const billing = await loadBillingCard(org.id, { flagOn: await billingUiEnabledForRequest() });

  // Approved but setting up (go-live slice S5): what the Go live banner
  // needs, for OWNER and ADMIN only. `settingUp` is false for every club
  // that is live, so their page shows nothing new.
  // NEVER FATAL (review of PR #236, fix 7): this block is optional, so a
  // failure here must not blank the settings page of a live club. The page
  // is sent without `setup`; the log names the club and nothing else.
  let setupView: Awaited<ReturnType<typeof loadClubSetupView>> = null;
  try {
    setupView = await loadClubSetupView(org.id);
  } catch (err) {
    console.error(`[org-settings] setup view failed for ${org.id}: ${err instanceof Error ? err.name : "error"}`);
  }

  return NextResponse.json({
    ...publicView,
    ...(setupView
      ? {
          setup: {
            settingUp: setupView.settingUp,
            removedFromGroup: setupView.removedFromGroup,
            group: setupView.group,
          },
        }
      : {}),
    // The name can be changed only while the club is a draft.
    nameEditable: org.approvalStatus === "draft",
    inviteCode: org.inviteCode,
    whatsappGroupId: f.whatsappGroupId,
    whatsappBotEnabled: f.whatsappBotEnabled,
    // Stripe Connect status — drives the "connect bank" button.
    stripeConnected: f.stripeConnected,
    stripeChargesEnabled: f.stripeChargesEnabled,
    // Money collector picker.
    paymentHolderId: f.paymentHolderId,
    members: members.map((m) => ({ id: m.user.id, name: m.user.name })),
    // "Weekly routine" (2026-09-30). Slices 2 and 3 add their settings here.
    weeklyRoutine: f.weeklyRoutine,
    billing,
    // "Monthly squad" (2026-10-05, slice 2). "weekly" for every club that
    // has not switched it on, so the section shows its one switch only.
    monthlySquad: f.monthlySquad,
  });
}

/** What the settings page shows of the club's facts, from the club summary
 *  (slice A4). Same shape and key order as `settingsFactsOfRow`. */
function settingsFactsOf(c: ClubRowFacts) {
  return {
    teamLabels: c.teamLabels,
    features: {
      attendance: c.features.attendance,
      bench: c.features.bench,
      teamBalancing: c.features.teamBalancing,
      momVoting: c.features.momVoting,
      playerRating: c.features.playerRating,
      reminders: c.features.reminders,
      statsQa: c.features.statsQa,
      paymentTracking: c.payments.tracking,
      paymentCollection: c.payments.collection,
      payByBank: c.payments.switches.payByBank,
      payCard: c.payments.switches.card,
      payDirect: c.payments.switches.direct,
      badgeAnnouncements: c.features.badgeAnnouncements,
      gearReminder: c.features.gearReminder,
    },
    whatsappGroupId: c.groups.playersGroupId,
    whatsappBotEnabled: c.lifecycle.botOn,
    stripeConnected: c.payments.stripe.accountConnected,
    stripeChargesEnabled: c.payments.stripe.chargesEnabled,
    paymentHolderId: c.payments.collector?.userId ?? null,
    weeklyRoutine: {
      rollingSquad: c.squad.rolling,
      ...weeklyDeadlinesView(c.routine.weeklyDeadlineSettings),
      // Slice 2b: who fills an open place, and the fallback.
      benchPickMode: c.routine.benchPickMode,
      benchPickFallback: c.routine.benchPickFallback,
      // 2026-10-14: who announces the list and teams.
      listAnnouncer: c.routine.listAnnouncer,
      // 2026-10-18: who chooses Man of the Match.
      momChosenBy: c.routine.momChosenBy,
    },
    monthlySquad: {
      squadMode: c.squad.mode,
      paygPricePence: c.squad.paygPricePence,
      monthListOpensDaysBefore: c.routine.monthListOpensDaysBefore,
      monthCreditRule: c.squad.creditRule,
      paymentInstructions: c.payments.instructions,
    },
  };
}

/** The same, as read before slice A4: the fallback when the club's facts
 *  cannot be built. */
function settingsFactsOfRow(org: Organisation): ReturnType<typeof settingsFactsOf> {
  return {
    teamLabels: org.teamLabels,
    features: {
      attendance: org.featureAttendance,
      bench: org.featureBench,
      teamBalancing: org.featureTeamBalancing,
      momVoting: org.featureMomVoting,
      playerRating: org.featurePlayerRating,
      reminders: org.featureReminders,
      statsQa: org.featureStatsQa,
      paymentTracking: org.paymentTrackingEnabled,
      paymentCollection: org.paymentCollectionEnabled,
      payByBank: org.payMethodPayByBank,
      payCard: org.payMethodCard,
      payDirect: org.payMethodDirect,
      badgeAnnouncements: org.featureBadgeAnnouncements,
      gearReminder: org.featureGearReminder,
    },
    whatsappGroupId: org.whatsappGroupId,
    whatsappBotEnabled: org.whatsappBotEnabled,
    stripeConnected: !!org.stripeConnectAccountId,
    stripeChargesEnabled: org.stripeChargesEnabled,
    paymentHolderId: org.paymentHolderId,
    weeklyRoutine: {
      rollingSquad: org.rollingSquadEnabled,
      ...weeklyDeadlinesView(org),
      benchPickMode: normaliseBenchPickMode(org.benchPickMode),
      benchPickFallback: normaliseBenchPickFallback(org.benchPickFallback),
      listAnnouncer: normaliseListAnnouncer(org.listAnnouncer),
      momChosenBy: normaliseMomChooser(org.momChosenBy),
    },
    monthlySquad: {
      squadMode: normaliseSquadMode(org.squadMode),
      paygPricePence: org.paygPricePence,
      monthListOpensDaysBefore: org.monthListOpensDaysBefore,
      monthCreditRule: normaliseCreditRule(org.monthCreditRule),
      paymentInstructions: org.paymentInstructions,
    },
  };
}
