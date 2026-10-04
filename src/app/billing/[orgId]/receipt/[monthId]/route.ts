import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { loadBillingAccess } from "@/lib/club-billing";
import { receiptInvoiceFor } from "@/lib/club-billing-month-summary";
import { getBillingStripe } from "@/lib/stripe-billing";
import { billingUiEnabledForRequest } from "@/lib/billing-flag";

export const dynamic = "force-dynamic";

/**
 * GET /billing/[orgId]/receipt/[monthId]: a past month's receipt (club fee
 * billing, slice P4). Sends the payer to Stripe's own hosted invoice page,
 * which carries the VAT breakdown and a PDF download.
 *
 * Only for the billing contact, only while the card on file is their own,
 * only for a paid month invoiced since that card went on
 * (`receiptAllowed`): the hosted page shows the payer's name, email and
 * billing address, so an earlier collector's receipt is never opened by the
 * next one, and an admin who reads the page sees no receipt links at all.
 * Anything else, or Stripe having no page for it, goes back to the billing
 * page (or 404 for somebody with no access), never to an error.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ orgId: string; monthId: string }> }) {
  const { orgId, monthId } = await params;
  const back = new URL(`/billing/${orgId}`, req.url);
  const session = await auth();
  if (!session?.user?.id) return NextResponse.redirect(new URL("/login", req.url));
  const userId = session.user.id;

  const access = await loadBillingAccess(userId, orgId, { flagOn: await billingUiEnabledForRequest() });
  if (!access) return new NextResponse("Not found", { status: 404 });

  const invoiceId = await receiptInvoiceFor(orgId, monthId, {
    role: access.role,
    userId,
    cardHolderUserId: access.snapshot.billing?.cardHolderUserId ?? null,
  });
  if (!invoiceId) return NextResponse.redirect(back);

  const stripe = getBillingStripe();
  if (!stripe) return NextResponse.redirect(new URL(`/billing/${orgId}?notice=not-set-up`, req.url));
  try {
    const invoice = await stripe.retrieveInvoice(invoiceId);
    if (invoice?.hostedInvoiceUrl) return NextResponse.redirect(invoice.hostedInvoiceUrl);
  } catch (err) {
    console.error("[billing] receipt: could not read the invoice", { orgId, monthId, err: err instanceof Error ? err.message : String(err) });
  }
  return NextResponse.redirect(new URL(`/billing/${orgId}?notice=failed`, req.url));
}
