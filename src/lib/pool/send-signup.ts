/**
 * The client side of POST /api/play/signup, kept out of the component so it
 * can be tested. On a successful sign-up it counts one `pool_signup` event
 * in Vercel Web Analytics, with no properties: no name, phone or postcode.
 * Analytics can never break a sign-up: a failure there is swallowed.
 */
import { track } from "@vercel/analytics";
import { POOL_SIGNUP_EVENT } from "@/lib/analytics";
import type { PoolErrorKey } from "@/lib/i18n/pool-play";
import type { PoolFieldErrors } from "@/lib/pool/profile-fields";

export interface PoolSignupConfirm {
  code: string;
  prefill: string;
  waLink: string;
  earlyList: boolean;
  /** For the /play reminder (`pending-signup.ts`): null when the server
   *  sent none, then the reminder simply has nothing to keep. */
  statusToken: string | null;
  /** When the code runs out, ms since the epoch, or null. */
  expiresAt: number | null;
}

export type PoolSignupResult =
  | { kind: "ok"; confirm: PoolSignupConfirm }
  | { kind: "fields"; errors: PoolFieldErrors }
  | { kind: "error"; reason: PoolErrorKey };

const SERVER_REASONS = ["busy", "area-not-found", "paused", "unavailable", "link-closed"] as const;

export async function sendPoolSignup(body: unknown, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<PoolSignupResult> {
  let data: Partial<Omit<PoolSignupConfirm, "expiresAt">> & { expiresAt?: unknown; ok?: boolean; reason?: string; errors?: PoolFieldErrors };
  try {
    const res = await fetchImpl("/api/play/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    data = (await res.json().catch(() => ({}))) as typeof data;
  } catch {
    return { kind: "error", reason: "generic" };
  }
  if (data.ok && data.code && data.waLink && data.prefill) {
    try {
      track(POOL_SIGNUP_EVENT);
    } catch {
      // Analytics blocked or broken: the sign-up still stands.
    }
    const expiresAt = typeof data.expiresAt === "string" ? Date.parse(data.expiresAt) : NaN;
    return {
      kind: "ok",
      confirm: {
        code: data.code,
        prefill: data.prefill,
        waLink: data.waLink,
        earlyList: !!data.earlyList,
        statusToken: typeof data.statusToken === "string" && data.statusToken ? data.statusToken : null,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
      },
    };
  }
  if (data.errors) return { kind: "fields", errors: data.errors };
  return { kind: "error", reason: SERVER_REASONS.find((r) => r === data.reason) ?? "generic" };
}
