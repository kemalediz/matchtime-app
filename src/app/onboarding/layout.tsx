import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { selfJoinEnabledForRequest } from "@/lib/self-join-flag";

/**
 * Guard: require auth. That's it.
 *
 * A user who already owns an org can still come here to spin up another
 * — plenty of admins run multiple groups (football + basketball,
 * Tuesdays + Saturdays, etc.). createOrgFromWizard adds a second OWNER
 * Membership cleanly; setCurrentOrgId pivots the session to the new org
 * on success.
 *
 * Unauthenticated users bounce to /login?callbackUrl=/onboarding so
 * they sign in first and land back here.
 *
 * Self-join on (slice 4): the wizard is closed and everybody goes to the
 * club setup form. A new phone signup lands here by default
 * (phone-signup.ts), so this is also how an organiser reaches it.
 */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/onboarding");
  }
  if (await selfJoinEnabledForRequest()) redirect("/create-org");
  return <>{children}</>;
}
