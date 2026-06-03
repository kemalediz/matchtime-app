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

/** Per-method processing uplift added to the base fee, in pounds.
 *  Card is the standard (highest) price; pay-by-bank and direct are
 *  discounts from it — the surcharge-safe framing. Tuned to safely
 *  cover Stripe UK fees on a ~£10 charge with a few pennies of headroom
 *  so the collector always nets ≥ base:
 *    - card        ~1.5% + 20p  → ~35p on £10  → 40p uplift
 *    - pay by bank ~5–30p flat  → 15p uplift (covers the typical rail)
 *    - direct      no processor → 0
 *  Rounded to the nearest 5p so prices read cleanly (e.g. £8.40, £8.15). */
const METHOD_UPLIFT: Record<PayMethod, number> = {
  card: 0.4,
  pay_by_bank: 0.15,
  direct: 0,
};

const METHOD_LABEL: Record<PayMethod, string> = {
  pay_by_bank: "Pay by Bank",
  card: "Card / Apple Pay",
  direct: "Pay the collector directly",
};

/** Round up to the nearest 5p so totals read cleanly and never net under
 *  base (we round the UPLIFT up, never down). */
function roundUp5p(pounds: number): number {
  return Math.ceil(pounds * 20) / 20;
}

export interface MethodPrice {
  method: PayMethod;
  label: string;
  /** Total the player pays for ONE person, including uplift. £. */
  total: number;
  /** The uplift portion (for transparency copy). £. */
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
      const fee = roundUp5p(METHOD_UPLIFT[method]);
      const total = method === "direct" ? baseFee : roundUp5p(baseFee + METHOD_UPLIFT[method]);
      return { method, label: METHOD_LABEL[method], total, fee };
    });
}

/** Total for a method when paying for `quantity` people (self + guests).
 *  Base scales by quantity; the processing uplift is charged ONCE per
 *  transaction (a single Stripe charge), which is why paying for others
 *  is cheaper per head. */
export function totalForMethod(baseFee: number, method: PayMethod, quantity: number): number {
  const base = baseFee * Math.max(1, quantity);
  if (method === "direct") return base;
  return roundUp5p(base + METHOD_UPLIFT[method]);
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
