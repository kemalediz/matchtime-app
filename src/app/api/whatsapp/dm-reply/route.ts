/**
 * Bot forwards every incoming 1-1 DM here. The DM pipeline itself is
 * `handleInboundDm` (src/lib/inbound-dm.ts), which the Cloud API webhook
 * calls too (Cloud API plan C3): this route is its thin adapter for the
 * Pi, the API key and the JSON parse, then one call.
 */
import { NextResponse } from "next/server";
import { handleInboundDm, type InboundDm } from "@/lib/inbound-dm";

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  return handleInboundDm(body as InboundDm, { channel: "baileys", request });
}
