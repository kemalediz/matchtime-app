"use client";

/**
 * Vercel Web Analytics (cookieless page views), rendered once in the root
 * layout. A client component so the URL clean-up (`analyticsBeforeSend`,
 * src/lib/analytics.ts) can be passed as a function.
 */
import { Analytics } from "@vercel/analytics/next";
import { analyticsBeforeSend } from "@/lib/analytics";

export function WebAnalytics() {
  return <Analytics beforeSend={analyticsBeforeSend} />;
}
