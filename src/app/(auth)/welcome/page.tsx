/**
 * /welcome: the first-visit name form for a signed-in player who is not
 * yet onboarded (src/app/page.tsx sends a not-onboarded user here when
 * they already have a number, else to /claim).
 *
 * The stored number is loaded here and shown read-only: it is the number
 * they sign in with. The form used to start empty and a blank field wiped
 * it (FNF 2026-10-18, src/lib/own-phone-rules.ts).
 */
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import WelcomeForm from "./welcome-form";

export default async function WelcomePage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const me = await db.user.findUnique({
    where: { id: session.user.id },
    select: { name: true, phoneNumber: true },
  });
  return <WelcomeForm initialName={me?.name ?? ""} currentPhone={me?.phoneNumber ?? null} />;
}
