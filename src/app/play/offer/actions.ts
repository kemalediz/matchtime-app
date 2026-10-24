"use server";

/**
 * The pool offer page's three buttons (local player pool L5a,
 * 2026-10-24). A server action is a public endpoint: the signed token is
 * the access control, checked here again (`pool/offer-token.ts`); the
 * rules and writes are `src/lib/pool/accept.ts`.
 */
import { acceptOffer, declineOffer, pullOutOfOffer } from "@/lib/pool/accept";
import type { OfferPageState } from "@/lib/pool/accept-rules";
import { offerIdFromToken } from "@/lib/pool/offer-token";

async function run(token: string, fn: (offerId: string) => Promise<OfferPageState>): Promise<{ state: OfferPageState }> {
  const offerId = typeof token === "string" ? offerIdFromToken(token) : null;
  if (!offerId) return { state: "invalid" };
  try {
    return { state: await fn(offerId) };
  } catch (err) {
    console.error(`[pool] offer ${offerId}: the page's answer failed:`, err instanceof Error ? err.message : "failed");
    return { state: "open" };
  }
}

export async function acceptPoolOfferAction(token: string) {
  return run(token, (id) => acceptOffer(id));
}

export async function declinePoolOfferAction(token: string) {
  return run(token, (id) => declineOffer(id));
}

export async function pullOutPoolOfferAction(token: string) {
  return run(token, (id) => pullOutOfOffer(id));
}
