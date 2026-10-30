/**
 * Payments — pricing + fee parsing (2026-06-03).
 *
 * Pure helpers, no Stripe, no DB. Turns a base per-player fee into the
 * method prices, in a surcharge-compliant way (UK: you can't add a card
 * surcharge, but you CAN discount cheaper methods, so card is the
 * standard/highest price and the others are discounts from it).
 *
 * What the money collector texts back ("£8", "8 each", "£112 total") is
 * read by the model (`fee-confirm.ts`, 2026-10-30), never parsed here.
 *
 * Money is handled in pounds (Float) at this layer; the Stripe layer
 * converts to integer pence at charge time.
 */

export type PayMethod = "pay_by_bank" | "card" | "direct";

/** The org fields that decide which ways a player can pay. */
export interface PayMethodSwitches {
  payMethodPayByBank: boolean;
  payMethodCard: boolean;
  payMethodDirect: boolean;
  stripeChargesEnabled: boolean;
}

/** The org fields `availablePayMethods` reads, as a Prisma select. */
export const PAY_METHOD_SELECT = {
  payMethodPayByBank: true,
  payMethodCard: true,
  payMethodDirect: true,
  stripeChargesEnabled: true,
} as const;

/**
 * The ways a player can ACTUALLY pay this club, in the pay page's order
 * (bank, card, direct). The one rule: the /pay page renders its buttons
 * from it, and the pay link, the daily chase and the collector's "links
 * sent" ack name exactly these (FNF, 2026-10-16: the DM promised bank,
 * card and Apple Pay to a club whose page offered only "pay directly").
 *
 * Card and Pay by Bank need the club switch AND the collector's
 * connected Stripe account able to take charges (`stripeChargesEnabled`,
 * written from the account by `refreshCollectorStatus`, cleared with the
 * account by `resetCollectorConnect`); this is the test the pay page has
 * always applied. Paying the collector directly needs only its switch.
 */
export function availablePayMethods(org: PayMethodSwitches): PayMethod[] {
  const out: PayMethod[] = [];
  if (org.payMethodPayByBank && org.stripeChargesEnabled) out.push("pay_by_bank");
  if (org.payMethodCard && org.stripeChargesEnabled) out.push("card");
  if (org.payMethodDirect) out.push("direct");
  return out;
}

/**
 * The club's own payment instructions (`Organisation.paymentInstructions`)
 * for a WEEKLY match fee: the trimmed text, shown verbatim, but only when
 * paying the collector directly is one of `availablePayMethods` (Kemal,
 * 2026-10-16: FNF's collector bank details were only in the group
 * description). Null when not set or when direct is not offered. The
 * /pay page, the pay link DM and the daily chase all read it from here.
 *
 * A monthly club gets null: its instructions already reach players with
 * the month's money, and its per-match copy stays exactly as it was.
 */
export function directPayInstructions(
  org: PayMethodSwitches & { paymentInstructions?: string | null; squadMode?: string | null },
): string | null {
  if (org.squadMode === "monthly") return null;
  const text = org.paymentInstructions?.trim();
  if (!text) return null;
  return availablePayMethods(org).includes("direct") ? text : null;
}

/** MatchTime's platform fee as a fraction of the base match fee — our
 *  revenue. 1% of base (e.g. 8p on £8). Skimmed from each Stripe-rail
 *  payment via `application_fee_amount`; "direct" (cash) is off-platform
 *  and carries none. Change this single number to reprice. */
export const PLATFORM_FEE_RATE = 0.01; // 1% of base

/** What a player pays by `method` on a £10 fee, as the copy prints it
 *  ("£10.36"). The settings blurbs and the in-group menu read it, so the
 *  amount they quote is always the one `totalForMethod` charges. */
export function totalOnTenPounds(method: Exclude<PayMethod, "direct">): string {
  return `£${totalForMethod(10, method, 1).toFixed(2)}`;
}

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
  card: "Card, Apple or Google Pay",
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
export function priceMethods(baseFee: number, enabled: PayMethod[], collector?: string | null): MethodPrice[] {
  const order: PayMethod[] = ["pay_by_bank", "card", "direct"];
  return order
    .filter((m) => enabled.includes(m))
    .map((method) => {
      const total = totalForMethod(baseFee, method, 1);
      // "Pay Raihan directly" when the collector's name is known, as the
      // pay link DM says it.
      const label = method === "direct" && collector ? `Pay ${collector} directly` : METHOD_LABEL[method];
      return { method, label, base: baseFee, total, fee: round2(total - baseFee) };
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

/** Format £ cleanly: £8, £8.50, £8.40. */
export function gbp(amount: number): string {
  return amount % 1 === 0 ? `£${amount.toFixed(0)}` : `£${amount.toFixed(2)}`;
}
