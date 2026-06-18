/**
 * Onboarding enrichment entrypoint.
 *
 * After an org is provisioned, this mines its stored chat history for
 * per-player positions, seed ratings, and the match schedule, then stashes
 * the proposals on the OnboardingSession for the admin to review and apply.
 *
 * Nothing here writes to live player records — it only updates the
 * OnboardingSession (enrichmentStatus + proposal blobs). Applying the
 * roster is a separate, admin-triggered action.
 *
 * History is passed IN as a parameter (never fetched here) so the function
 * stays injectable and end-to-end testable without a WhatsApp dependency.
 */

import { db } from "@/lib/db";
import { analyzeForOnboarding } from "@/lib/onboarding-analyzer";
import {
  buildParsedChatFromHistory,
  reconcileProposals,
  detectUnresolvedMembers,
  type HistoryMessage,
  type ProposedRosterEntry,
  type CapturedSchedule,
} from "@/lib/onboarding-enrichment-reconcile";

export interface RunEnrichmentArgs {
  sessionId: string;
  history: HistoryMessage[];
}

export interface EnrichmentSummary {
  status: "ready" | "noop";
  messagesAnalyzed: number;
  playerCount: number;
  unresolvedCount: number;
}

export async function runOnboardingEnrichment(
  args: RunEnrichmentArgs,
): Promise<EnrichmentSummary> {
  const session = await db.onboardingSession.findUnique({
    where: { id: args.sessionId },
  });
  if (!session) throw new Error(`OnboardingSession ${args.sessionId} not found`);

  // No history → graceful no-op, leave enrichmentStatus untouched.
  if (!args.history || args.history.length === 0) {
    return { status: "noop", messagesAnalyzed: 0, playerCount: 0, unresolvedCount: 0 };
  }

  if (!session.orgId) {
    throw new Error(`OnboardingSession ${args.sessionId} has no orgId yet`);
  }
  const orgId = session.orgId;

  // Resolve the org's sport (name + valid positions).
  const sport = await db.sport.findFirst({ where: { orgId } });
  if (!sport) throw new Error(`No Sport found for org ${orgId}`);
  const sportName = sport.name;
  const validPositions = sport.positions;

  // Load active members + the few user fields we need.
  const memberships = await db.membership.findMany({
    where: { orgId, leftAt: null },
    include: {
      user: { select: { id: true, name: true, phoneNumber: true } },
    },
  });
  const members = memberships.map((m) => m.user);
  const candidateNames = members
    .map((u) => u.name)
    .filter((n): n is string => !!n);

  const parsed = buildParsedChatFromHistory(args.history);
  const messagesAnalyzed = parsed.recentMessages.length;

  const analysis = await analyzeForOnboarding({
    parsed,
    sportName,
    validPositions,
    candidateNames,
  });

  // Analyser unavailable / failed → still "ready", just with no proposals.
  if (!analysis) {
    const unresolved = detectUnresolvedMembers(members);
    await db.onboardingSession.update({
      where: { id: args.sessionId },
      data: {
        enrichmentStatus: "ready",
        messagesAnalyzed,
        proposedRoster: [],
        unresolvedMembers: unresolved,
      },
    });
    return {
      status: "ready",
      messagesAnalyzed,
      playerCount: 0,
      unresolvedCount: unresolved.length,
    };
  }

  const proposedRoster: ProposedRosterEntry[] = reconcileProposals(
    analysis.players,
    members.map((u) => ({ id: u.id, name: u.name })),
  );
  const unresolvedMembers = detectUnresolvedMembers(members);

  // Merge analyser schedule with what onboarding already captured.
  const playersPerSide = session.playersPerSide ?? null;
  const capturedSchedule: CapturedSchedule = {
    dayOfWeek: analysis.schedule.dayOfWeek,
    time: analysis.schedule.time,
    venue: analysis.schedule.venue,
    playersPerSide,
    capacity: playersPerSide != null ? playersPerSide * 2 : null,
  };

  await db.onboardingSession.update({
    where: { id: args.sessionId },
    data: {
      enrichmentStatus: "ready",
      messagesAnalyzed,
      // Cast through `unknown`: our typed structs carry `null`/optional
      // fields that don't line up with Prisma's InputJsonValue, but the
      // shapes are valid JSON.
      proposedRoster: proposedRoster as unknown as object,
      unresolvedMembers: unresolvedMembers as unknown as object,
      capturedSchedule: capturedSchedule as unknown as object,
    },
  });

  return {
    status: "ready",
    messagesAnalyzed,
    playerCount: proposedRoster.length,
    unresolvedCount: unresolvedMembers.length,
  };
}
