/**
 * Create the Stripe Connect (Express) account + hosted onboarding link for
 * the mt-test-payments org, mirroring startCollectorOnboarding. Prints the
 * onboarding URL to drive in the browser. Re-run prints a fresh link for
 * the same account (links are single-use / short-lived).
 */
import { db } from "@/lib/db";
import { isStripeConfigured, createConnectAccount, createOnboardingLink } from "@/lib/stripe";

const SLUG = "mt-test-payments";

async function main() {
  if (!isStripeConfigured()) throw new Error("STRIPE_SECRET_KEY not in env for this run");
  const org = await db.organisation.findUnique({
    where: { slug: SLUG },
    select: { id: true, name: true, stripeConnectAccountId: true, paymentHolderId: true },
  });
  if (!org) throw new Error("test org not found — run seed-pay-test.ts first");

  let accountId = org.stripeConnectAccountId;
  if (!accountId) {
    let email: string | null = null;
    if (org.paymentHolderId) {
      const holder = await db.user.findUnique({
        where: { id: org.paymentHolderId },
        select: { email: true },
      });
      if (holder?.email && !holder.email.endsWith("@matchtime.local")) email = holder.email;
    }
    accountId = await createConnectAccount({ email, orgName: org.name });
    await db.organisation.update({
      where: { id: org.id },
      data: { stripeConnectAccountId: accountId, stripeChargesEnabled: false },
    });
    console.log("created Connect account:", accountId);
  } else {
    console.log("reusing Connect account:", accountId);
  }

  const url = await createOnboardingLink(accountId, "/admin/settings");
  console.log("\nONBOARDING_URL:", url);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
