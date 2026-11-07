/**
 * META'S WEBHOOK FOR THE OFFICIAL NUMBER (WhatsApp Cloud API plan, PR C5;
 * MDs/whatsapp-cloud-api-plan-2026-11-04.md sections 2 step 12, 5.2 and
 * 5.8). The Callback URL Kemal registers in the app dashboard:
 * https://matchtime.ai/api/whatsapp/cloud/webhook. A thin adapter; the
 * work is src/lib/cloud-api/webhook.ts.
 *
 *   GET   the handshake: 200 with `hub.challenge` only for
 *         hub.mode=subscribe and WA_CLOUD_VERIFY_TOKEN, else 403. Works
 *         whatever CLOUD_API_ENABLED says.
 *   POST  the RAW body's `X-Hub-Signature-256` checked against
 *         WA_CLOUD_APP_SECRET (401 when it does not match). With
 *         CLOUD_API_ENABLED off: 200 and nothing else. On: each message
 *         recorded once, 200 at once, and the rest in `after()`: texts into
 *         the one DM pipeline, statuses onto their jobs, template updates.
 *
 * Public by its prefix (/api/whatsapp, src/lib/public-paths.ts): the
 * signature is the access control.
 */
import { after, NextResponse } from "next/server";
import { acceptCloudWebhook } from "@/lib/cloud-api/webhook";
import { handshakeChallenge } from "@/lib/cloud-api/webhook-auth";

/** Seconds. `after()` runs within the route's max duration (Next.js
 *  docs, `after`), so a message claimed here is never still running once
 *  `INBOUND_RETRY_AFTER_MS` (15 minutes) has passed and the sweep may
 *  retry it. Pinned by webhook.test.ts and route.test.ts. */
export const maxDuration = 300;

export async function GET(request: Request) {
  const challenge = handshakeChallenge(new URL(request.url).searchParams, process.env.WA_CLOUD_VERIFY_TOKEN);
  if (challenge === null) return new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain" } });
  return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

export async function POST(request: Request) {
  // The bytes Meta signed, before anything decodes them.
  const rawBody = Buffer.from(await request.arrayBuffer());
  const accepted = await acceptCloudWebhook({ rawBody, signature: request.headers.get("x-hub-signature-256"), request });
  const work = accepted.work;
  if (work) {
    after(async () => {
      try {
        await work();
      } catch (err) {
        console.error(`[cloud-webhook] the work after the response failed: ${(err as Error)?.name ?? "error"}`);
      }
    });
  }
  return NextResponse.json(accepted.body, { status: accepted.status });
}
