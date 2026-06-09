/**
 * Payments — pricing + fee parsing (2026-06-03).
 *
 * Pure helpers, no Stripe, no DB. Two jobs:
 *   1. Turn a base per-player fee into the THREE method prices, in a
 *      surcharge-compliant way (UK: you can't add a card surcharge, but
 *      you CAN discount cheaper methods — so card is the standard/highest
 *      price and the others are discounts from it).
 *   2. Parse what the money collector texts back ("£8", "8 each",
 *      "£112 total") into a per-player base fee.
 *
 * Money is handled in pounds (Float) at this layer; the Stripe layer
 * converts to integer pence at charge time.
 */

export type PayMethod = "pay_by_bank" | "card" | "direct";

/** MatchTime's platform fee as a fraction of the base match fee — our
 *  revenue. 1% of base (e.g. 8p on £8). Skimmed from each Stripe-rail
 *  payment via `application_fee_amount`; "direct" (cash) is off-platform
 *  and carries none. Change this single number to reprice. */
export const PLATFORM_FEE_RATE = 0.01; // 1% of base

/** Stripe UK processing rates by rail (2026): % of the charge + a fixed
 *  fee. Passed through exactly so the collector nets the full base fee.
 *    - card        1.5% + 20p
 *    - pay by bank 0.5% + 20p (cap £5 — never reached at match-fee sizes) */
const STRIPE_FEE: Record<Exclude<PayMethod, "direct">, { pct: number; fixed: number }> = {
  card: { pct: 0.015, fixed: 0.2 },
  pay_by_bank: { pct: 0.005, fixed: 0.2 },
};

const METHOD_LABEL: Record<PayMethod, string> = {
  pay_by_bank: "Pay by Bank",
  card: "Card / Apple Pay / Google Pay",
  direct: "Pay the collector directly",
};

/** Round to the nearest penny. */
function round2(pounds: number): number {
  return Math.round(pounds * 100) / 100;
}

export interface MethodPrice {
  method: PayMethod;
  label: string;
  /** Per-person base match fee. £. */
  base: number;
  /** Total the player pays for ONE person, incl. Stripe + platform fee. £. */
  total: number;
  /** The add-on (total − base): Stripe's fee + MatchTime's 1%. £. */
  fee: number;
}

/** Price a single base fee across the enabled methods. `enabled` filters
 *  to the org's switched-on methods; order is bank → card → direct
 *  (cheapest first, but card stays the "standard" reference price). */
export function priceMethods(baseFee: number, enabled: PayMethod[]): MethodPrice[] {
  const order: PayMethod[] = ["pay_by_bank", "card", "direct"];
  return order
    .filter((m) => enabled.includes(m))
    .map((method) => {
      const total = totalForMethod(baseFee, method, 1);
      return { method, label: METHOD_LABEL[method], base: baseFee, total, fee: round2(total - baseFee) };
    });
}

/** Exact total a player pays for `quantity` people via `method`, in £.
 *  Grosses up so that after Stripe's fee AND MatchTime's 1% platform fee,
 *  the collector nets exactly base×quantity:
 *
 *    G = (base·qty + stripeFixed + platform) / (1 − stripePct)
 *
 *  Rounded UP to the penny so the collector is never left short — the
 *  ≤1p penny-rounding residual (unavoidable, since charges are integer
 *  pence) falls to the collector, never against them. Direct = base×qty
 *  (off-platform, no fees). */
export function totalForMethod(baseFee: number, method: PayMethod, quantity: number): number {
  const qty = Math.max(1, quantity);
  const baseTotal = baseFee * qty;
  if (method === "direct") return round2(baseTotal);
  const { pct, fixed } = STRIPE_FEE[method];
  const platform = baseTotal * PLATFORM_FEE_RATE;
  const gross = (baseTotal + fixed + platform) / (1 - pct);
  return Math.ceil(gross * 100) / 100;
}

/** MatchTime's platform fee for a payment, in PENCE — passed to Stripe as
 *  `application_fee_amount` on the connected-account charge. 1% of
 *  base×quantity. Returns 0 for "direct" (off-platform, no Stripe charge). */
export function platformFeePence(baseFee: number, method: PayMethod, quantity: number): number {
  if (method === "direct") return 0;
  return Math.round(baseFee * Math.max(1, quantity) * PLATFORM_FEE_RATE * 100);
}

export interface ParsedFee {
  /** Per-player base fee in £ (already divided if the collector gave a total). */
  perPlayer: number;
  /** True when the collector gave a TOTAL to split rather than a per-head amount. */
  wasTotal: boolean;
}

/**
 * Parse the money collector's chat reply into a per-player base fee.
 * Handles: "£8", "8", "8 each", "8 per person", "£8.50", "8 quid",
 * "£112 total", "112 split", "split 112". When a total is given, divide
 * by `headcount` (the players who'll be charged) — caller supplies it.
 * Returns null if no sensible amount found.
 */
export function parseFeeReply(text: string, headcount: number): ParsedFee | null {
  const t = text.toLowerCase().trim();
  // Grab the first money-looking number (allow £ and decimals).
  const numMatch = t.match(/£?\s*(\d+(?:\.\d{1,2})?)/);
  if (!numMatch) return null;
  const amount = parseFloat(numMatch[1]);
  if (!isFinite(amount) || amount <= 0 || amount > 1000) return null;

  const isTotal = /\b(total|split|altogether|in total|the pitch|pitch (was|cost))\b/.test(t);
  if (isTotal) {
    if (headcount <= 0) return null;
    const per = Math.round((amount / headcount) * 100) / 100;
    return { perPlayer: per, wasTotal: true };
  }
  // Otherwise treat as per-player ("8", "8 each", "£8.50 pp").
  return { perPlayer: amount, wasTotal: false };
}

/** Format £ cleanly: £8, £8.50, £8.40. */
export function gbp(amount: number): string {
  return amount % 1 === 0 ? `£${amount.toFixed(0)}` : `£${amount.toFixed(2)}`;
}
