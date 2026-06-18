/**
 * Onboarding enrichment review page.
 *
 * After the bot mines the group's chat history into a proposed roster, the
 * admin lands here (via a magic link / dashboard prompt) to review and
 * apply seed ratings, positions, missing phones, and the schedule.
 *
 * Server component: gate on auth + org-admin, load the stashed proposal off
 * OnboardingSession, hand it to the client form. Friendly cards for the
 * not-found / no-access / already-applied edge cases (never crash).
 */
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isOrgAdmin } from "@/lib/org";
import { redirect } from "next/navigation";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import type {
  ProposedRosterEntry,
  CapturedSchedule,
} from "@/lib/onboarding-enrichment-reconcile";
import { FinishSetupForm } from "./FinishSetupForm";

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white rounded-xl border border-slate-200 shadow-sm p-8 text-center">
        {children}
      </div>
    </div>
  );
}

export default async function FinishSetupPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const onb = await db.onboardingSession.findUnique({ where: { id: sessionId } });
  if (!onb || !onb.orgId) {
    return (
      <Centered>
        <h1 className="text-lg font-semibold text-slate-800">Setup link expired or not found</h1>
        <p className="text-sm text-slate-500 mt-2">
          This setup session no longer exists. Ask your group admin for a fresh link.
        </p>
      </Centered>
    );
  }

  const ok = await isOrgAdmin(session.user.id, onb.orgId);
  if (!ok) {
    return (
      <Centered>
        <h1 className="text-lg font-semibold text-slate-800">You don&apos;t have access to this setup</h1>
        <p className="text-sm text-slate-500 mt-2">
          Only an admin of this group can review and apply the proposed roster.
        </p>
      </Centered>
    );
  }

  if (onb.enrichmentStatus === "applied") {
    return (
      <Centered>
        <CheckCircle2 className="w-10 h-10 text-green-600 mx-auto" />
        <h1 className="text-lg font-semibold text-slate-800 mt-3">Setup already completed ✓</h1>
        <p className="text-sm text-slate-500 mt-2">
          This group&apos;s roster has been applied. You can manage everything from the dashboard.
        </p>
        <Link
          href="/admin"
          className="inline-flex items-center justify-center h-11 px-5 mt-5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
        >
          Go to dashboard
        </Link>
      </Centered>
    );
  }

  const roster = (onb.proposedRoster as unknown as ProposedRosterEntry[] | null) ?? [];
  const unresolved =
    (onb.unresolvedMembers as unknown as { name: string | null; userId: string }[] | null) ?? [];
  const schedule = (onb.capturedSchedule as unknown as CapturedSchedule | null) ?? {};

  const sport = await db.sport.findFirst({ where: { orgId: onb.orgId } });
  const positions = sport?.positions ?? [];

  return (
    <FinishSetupForm
      sessionId={sessionId}
      roster={roster}
      unresolved={unresolved}
      schedule={schedule}
      positions={positions}
    />
  );
}
