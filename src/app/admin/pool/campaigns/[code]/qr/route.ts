/**
 * GET /admin/pool/campaigns/<code>/qr?format=png|svg: a campaign link's QR
 * code as a download (pool slice G1). OWNER ONLY: 404 to anybody who is
 * not `User.isSuperadmin`, and for a code that does not exist.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isSuperadmin } from "@/lib/org";
import { poolCampaignLink } from "@/lib/pool/campaigns";
import { poolQrPng, poolQrSvg, readQrFormat } from "@/lib/pool/qr";

export const dynamic = "force-dynamic";

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const userId = (await auth())?.user?.id;
  if (!userId || !(await isSuperadmin(userId))) return notFound();
  const { code } = await params;
  const url = await poolCampaignLink(code);
  if (!url) return notFound();

  const format = readQrFormat(new URL(request.url).searchParams.get("format"));
  const name = `matchtime-play-${code}.${format}`;
  const headers = { "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store" };
  if (format === "svg") return new NextResponse(await poolQrSvg(url), { headers: { ...headers, "Content-Type": "image/svg+xml" } });
  return new NextResponse(new Uint8Array(await poolQrPng(url)), { headers: { ...headers, "Content-Type": "image/png" } });
}
