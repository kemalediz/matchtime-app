/**
 * THE CLOUD WEBHOOK, AS KEMAL REGISTERS IT (WhatsApp Cloud API plan, PR C5,
 * section 2 step 12): against the real route and a real Postgres, with
 * CLOUD_API_ENABLED unset as it will be on the day he saves the Callback
 * URL. The handshake answers; a POST signed by the Cloud API stub's helper,
 * as Meta signs it, is 200 and writes nothing; an unsigned one is 401.
 *
 * Deterministic: no model and no Meta call is involved.
 */
import { test, expect } from "../fixtures";
import { E2E, E2E_BASE_URL } from "../helpers/env";
import { testDb } from "../helpers/test-db";
import { postSignedWebhook, statusWebhookPayload } from "../stubs/cloud-api";

const URL_PATH = "/api/whatsapp/cloud/webhook";

const textPayload = (wamid: string) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "e2e-waba",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "447700900000", phone_number_id: "e2e-number" },
            contacts: [{ profile: { name: "Sam" }, wa_id: "447700900961" }],
            messages: [{ from: "447700900961", id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "IN" } }],
          },
        },
      ],
    },
  ],
});

test.describe("Cloud webhook with CLOUD_API_ENABLED unset", () => {
  test("GET: the handshake answers the challenge for our verify token, 403 otherwise", async ({ request }) => {
    const ok = await request.get(URL_PATH, { params: { "hub.mode": "subscribe", "hub.verify_token": E2E.WA_CLOUD_VERIFY_TOKEN, "hub.challenge": "8675309" } });
    expect(ok.status()).toBe(200);
    expect(await ok.text()).toBe("8675309");
    const wrong = await request.get(URL_PATH, { params: { "hub.mode": "subscribe", "hub.verify_token": "guess", "hub.challenge": "8675309" } });
    expect(wrong.status()).toBe(403);
  });

  test("POST signed as Meta signs it: 200, and nothing is written", async () => {
    const wamid = `wamid.E2E-OFF-${Date.now()}`;
    const url = `${E2E_BASE_URL}${URL_PATH}`;
    expect(await postSignedWebhook({ url, appSecret: E2E.WA_CLOUD_APP_SECRET, payload: textPayload(wamid) })).toBe(200);
    expect(await postSignedWebhook({ url, appSecret: E2E.WA_CLOUD_APP_SECRET, payload: statusWebhookPayload({ phoneNumberId: "e2e-number", wamid, recipient: "447700900961", status: "delivered" }) })).toBe(200);
    expect(await testDb().count(`SELECT COUNT(*) AS n FROM "WaInbound" WHERE wamid = $1`, [wamid])).toBe(0);
  });

  test("POST with no signature, or signed with another secret: 401", async () => {
    const url = `${E2E_BASE_URL}${URL_PATH}`;
    const payload = textPayload(`wamid.E2E-BAD-${Date.now()}`);
    expect(await postSignedWebhook({ url, appSecret: "not-the-app-secret", payload })).toBe(401);
    expect(await postSignedWebhook({ url, appSecret: E2E.WA_CLOUD_APP_SECRET, payload, signature: "" })).toBe(401);
  });
});
