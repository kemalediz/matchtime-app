/**
 * The guard for scripts/billing-local-test.ts (club fee billing, local Stripe
 * TEST mode run on Kemal's Mac; runbook in
 * MDs/club-fee-billing-plan-2026-10-01.md section 16). PURE.
 *
 * The repo's `.env` points at the PRODUCTION database. The helper writes
 * rows and the app it drives talks to Stripe, so it runs only when every
 * one of these is true, and says which one is not:
 *   - DATABASE_URL and DIRECT_URL are on this machine (localhost, 127.0.0.1
 *     or ::1);
 *   - STRIPE_SECRET_KEY is a TEST key (sk_test_);
 *   - NEXTAUTH_URL (the links the app builds, and Stripe's return page) is
 *     localhost, so no link it prints can reach the real site.
 */
import { formatLondon } from "./london-time";

type Env = Record<string, string | undefined>;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLocalUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const host = new URL(raw).hostname;
    return LOCAL_HOSTS.has(host);
  } catch {
    return false;
  }
}

/** Null when the environment is safe for the local test, else the reason. */
export function localBillingTestRefusal(env: Env): string | null {
  for (const name of ["DATABASE_URL", "DIRECT_URL"] as const) {
    if (!isLocalUrl(env[name])) return `${name} must be a database on this Mac (localhost). Source .env.billing-local first.`;
  }
  if (!env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) return "STRIPE_SECRET_KEY must be a Stripe TEST key (sk_test_...).";
  if (!isLocalUrl(env.NEXTAUTH_URL)) return "NEXTAUTH_URL must be http://localhost:3000 so links and Stripe's return page stay on this Mac.";
  return null;
}

// ── The helper's time display ───────────────────────────────────────────

/**
 * A Postgres `TIMESTAMP WITHOUT TIME ZONE` value as the UTC instant it
 * holds (Prisma stores UTC there). node-pg's default parser reads such a
 * value as the machine's LOCAL time, so on a Mac in BST every time printed
 * by the helper was an hour off (test mode, 2026-10-05). The helper
 * registers this as the parser for type 1114.
 */
export function parsePgUtcTimestamp(value: string): Date {
  return new Date(`${value.trim().replace(" ", "T")}Z`);
}

/** The row with every Date shown as London wall-clock time, labelled. */
export function londonRow<T extends Record<string, unknown>>(row: T): Record<keyof T, unknown> {
  const out = {} as Record<keyof T, unknown>;
  for (const [k, v] of Object.entries(row) as Array<[keyof T, unknown]>) {
    out[k] = v instanceof Date ? `${formatLondon(v, "yyyy-MM-dd HH:mm")} London` : v;
  }
  return out;
}
