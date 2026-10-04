/**
 * CLUB FEE BILLING, slice B4: the hourly billing scheduler.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, section 6.
 *
 * Hourly from vercel.json, behind CRON_SECRET like every other cron. The
 * work is `runBillingCron` (src/lib/club-billing-scheduler.ts): unpaid
 * club fee invoices of clubs no longer billed are voided (slice P2); with
 * BILLING_ENABLED on, the free month and grace week ended on time, and the
 * billing contact's DMs and the admins' club fee tip sent in the daytime
 * (10:00 to 20:00 London). With the flag off it only voids those invoices.
 */
import { NextResponse } from "next/server";
import { runBillingCron } from "@/lib/club-billing-scheduler";

export async function GET(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // TEST-ONLY clock override (e2e suite), gated on MT_TEST_MODE=1 exactly
  // like the other crons, and never set in production.
  let now = new Date();
  if (process.env.MT_TEST_MODE === "1") {
    const pinned = new Date(request.headers.get("x-test-now") ?? "");
    if (!Number.isNaN(pinned.getTime())) now = pinned;
  }
  const report = await runBillingCron(now);
  return NextResponse.json(report);
}
