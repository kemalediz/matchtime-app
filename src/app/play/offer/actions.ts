"use server";

/**
 * The pool offer page's three answers (local player pool L5a, 2026-10-24;
 * review of #400, M2). A server action is a public endpoint: the signed
 * token names the offer, and each answer runs only for its HOLDER: signed
 * in as him, or with his last 4 digits (`checkOfferDigits`, rate-limited),
 * after which a cookie for this one offer keeps this phone proved. The
 * rules and writes are `src/lib/pool/accept.ts`.
 */
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { acceptOffer, checkOfferDigits, declineOffer, isOfferHolder, pullOutOfOffer } from "@/lib/pool/accept";
import type { OfferPageState } from "@/lib/pool/accept-rules";
import { POOL_OFFER_PROOF, proofCookieName } from "@/lib/pool/offer-proof-rules";
import { offerIdFromToken, poolOfferProof } from "@/lib/pool/offer-token";
import { POOL_OFFER_PATH_PREFIX } from "@/lib/pool/offer-token";
import { poolEnvForRequest } from "@/lib/pool/switch-env";

type Answer = { state: OfferPageState | null; verify?: "needed" | "wrong" | "locked" };

async function run(token: string, digits: string | null, fn: (offerId: string) => Promise<OfferPageState>): Promise<Answer> {
  const offerId = typeof token === "string" ? offerIdFromToken(token) : null;
  if (!offerId) return { state: "invalid" };
  try {
    const jar = await cookies();
    const session = await auth();
    let holder = await isOfferHolder(offerId, { sessionUserId: session?.user?.id ?? null, proof: jar.get(proofCookieName(offerId))?.value ?? null });
    if (!holder) {
      if (!digits) return { state: null, verify: "needed" };
      const answer = await checkOfferDigits(offerId, digits);
      if (answer !== "ok") return { state: null, verify: answer };
      jar.set(proofCookieName(offerId), poolOfferProof(offerId), {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: POOL_OFFER_PATH_PREFIX,
        maxAge: POOL_OFFER_PROOF.cookieDays * 24 * 3600,
      });
      holder = true;
    }
    return { state: await fn(offerId) };
  } catch (err) {
    console.error(`[pool] offer ${offerId}: the page's answer failed:`, err instanceof Error ? err.message : "failed");
    return { state: "open" };
  }
}

export async function acceptPoolOfferAction(token: string, digits: string | null = null): Promise<Answer> {
  const env = await poolEnvForRequest();
  return run(token, digits, (id) => acceptOffer(id, new Date(), env));
}

export async function declinePoolOfferAction(token: string, digits: string | null = null): Promise<Answer> {
  return run(token, digits, (id) => declineOffer(id));
}

export async function pullOutPoolOfferAction(token: string, digits: string | null = null): Promise<Answer> {
  return run(token, digits, (id) => pullOutOfOffer(id));
}

/** "Show my offer": the digits alone, so the page can show HIS offer's
 *  state (second review of #400, item 4: unproved, it shows the game only). */
export async function provePoolOfferAction(token: string, digits: string | null = null): Promise<Answer> {
  return run(token, digits, async () => "open");
}
