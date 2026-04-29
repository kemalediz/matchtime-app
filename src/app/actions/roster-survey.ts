"use server";

/**
 * Admin actions for roster check-in surveys.
 *   - overrideResponse: admin manually re-classifies a response (or
 *     creates one for a member who hasn't replied). Sets
 *     adminOverride=true so subsequent DM replies don't re-flip it.
 *   - closeSurvey: marks a survey closed. Future DMs from people
 *     who got a check-in won't trigger classification + the daily
 *     group update (TBD) stops firing.
 */
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireOrgAdmin } from "@/lib/org";
import { revalidatePath } from "next/cache";

export async function overrideResponse(args: {
  surveyId: string;
  userId: string;
  response: "in" | "maybe" | "out" | "unclear";
  rawReply?: string;
}) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const survey = await db.rosterSurvey.findUnique({
    where: { id: args.surveyId },
    select: { orgId: true },
  });
  if (!survey) throw new Error("Survey not found");
  await requireOrgAdmin(session.user.id, survey.orgId);

  await db.rosterSurveyResponse.upsert({
    where: {
      surveyId_userId: { surveyId: args.surveyId, userId: args.userId },
    },
    create: {
      surveyId: args.surveyId,
      userId: args.userId,
      response: args.response,
      rawReply: args.rawReply ?? "(admin-set)",
      adminOverride: true,
    },
    update: {
      response: args.response,
      adminOverride: true,
      classifiedAt: new Date(),
    },
  });
  revalidatePath(`/admin/roster-survey/${args.surveyId}`);
}

export async function closeSurvey(surveyId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const survey = await db.rosterSurvey.findUnique({
    where: { id: surveyId },
    select: { orgId: true },
  });
  if (!survey) throw new Error("Survey not found");
  await requireOrgAdmin(session.user.id, survey.orgId);

  await db.rosterSurvey.update({
    where: { id: surveyId },
    data: {
      status: "closed",
      closedAt: new Date(),
      closedById: session.user.id,
    },
  });
  revalidatePath(`/admin/roster-survey/${surveyId}`);
  revalidatePath(`/admin/roster-survey`);
}

export async function reopenSurvey(surveyId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const survey = await db.rosterSurvey.findUnique({
    where: { id: surveyId },
    select: { orgId: true },
  });
  if (!survey) throw new Error("Survey not found");
  await requireOrgAdmin(session.user.id, survey.orgId);

  await db.rosterSurvey.update({
    where: { id: surveyId },
    data: { status: "open", closedAt: null, closedById: null },
  });
  revalidatePath(`/admin/roster-survey/${surveyId}`);
  revalidatePath(`/admin/roster-survey`);
}
