/**
 * A LOCAL STAND-IN FOR META'S CLOUD API (WhatsApp Cloud API plan, PR C4,
 * section 5.9). Nothing in the test suites ever talks to Meta: the server
 * points `WA_CLOUD_API_BASE` here, which `src/lib/cloud-api/client.ts`
 * honours only under MT_TEST_MODE=1.
 *
 *   POST /<version>/<PHONE_NUMBER_ID>/messages
 *        recorded (path, version, phone number id, whether the token was
 *        right, the JSON body; never the token itself) and answered like
 *        Meta: `{ messaging_product, contacts, messages: [{ id }] }` with a
 *        fake wamid, or whatever `answerNext` / `answerFor` queued: any
 *        HTTP status, any Meta error code, a body that is not Meta's, a
 *        delay (a timeout).
 *   A wrong token is Meta's 401 with code 190.
 *
 * WEBHOOKS BACK (for PR C5): `statusWebhookPayload` builds Meta's status
 * update for a wamid and `postSignedWebhook` posts it to our webhook route
 * with `X-Hub-Signature-256` signed by the app secret, as Meta does. C5's
 * route (/api/whatsapp/cloud/webhook) is what they post to.
 */
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface CloudStubAnswer {
  httpStatus?: number;
  /** Meta's error object; sent as `{ error: { ... } }`. */
  error?: { code: number; message?: string; subcode?: number };
  /** A body that is not Meta's JSON (a gateway page). */
  rawBody?: string;
  /** Wait this long before answering. */
  delayMs?: number;
  /** The wamid to return on success, instead of a fresh fake one. */
  wamid?: string;
}

export interface CloudStubRequest {
  method: string;
  path: string;
  version: string | null;
  phoneNumberId: string | null;
  /** The bearer token was the stub's (or any bearer, when none was set). */
  authorised: boolean;
  body: unknown;
  /** The wamid the stub answered with, when it answered with one. */
  wamid: string | null;
}

export interface CloudApiStub {
  url: string;
  requests: CloudStubRequest[];
  /** Queue answers for the next requests, in order. */
  answerNext(...answers: CloudStubAnswer[]): void;
  /** Answer every request to this number this way until reset. */
  answerFor(to: string, answer: CloudStubAnswer): void;
  reset(): void;
  close(): Promise<void>;
}

const MESSAGES_PATH = /^\/(v\d+\.\d+)\/([^/]+)\/messages$/;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startCloudApiStub(opts: { port?: number; token?: string } = {}): Promise<CloudApiStub> {
  const requests: CloudStubRequest[] = [];
  let queue: CloudStubAnswer[] = [];
  let byNumber = new Map<string, CloudStubAnswer>();
  let seq = 0;

  const send = (res: ServerResponse, status: number, body: string, json = true) => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { "content-type": json ? "application/json" : "text/html" });
    res.end(body);
  };

  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const path = (req.url ?? "").split("?")[0];
    const m = MESSAGES_PATH.exec(path);
    const auth = req.headers.authorization ?? "";
    const authorised = opts.token ? auth === `Bearer ${opts.token}` : auth.startsWith("Bearer ");
    const rec: CloudStubRequest = { method: req.method ?? "", path, version: m?.[1] ?? null, phoneNumberId: m?.[2] ?? null, authorised, body, wamid: null };
    requests.push(rec);

    if (req.method !== "POST" || !m) return send(res, 404, JSON.stringify({ error: { code: 100, message: "Unsupported request" } }));
    if (!authorised) return send(res, 401, JSON.stringify({ error: { code: 190, message: "Invalid OAuth access token" } }));

    const to = typeof (body as { to?: unknown })?.to === "string" ? (body as { to: string }).to : "";
    const answer = queue.shift() ?? byNumber.get(to) ?? {};
    if (answer.delayMs) await new Promise((r) => setTimeout(r, answer.delayMs));
    if (answer.rawBody !== undefined) return send(res, answer.httpStatus ?? 200, answer.rawBody, false);
    if (answer.error) {
      const e = answer.error;
      return send(res, answer.httpStatus ?? 400, JSON.stringify({ error: { message: e.message ?? "error", type: "OAuthException", code: e.code, error_subcode: e.subcode, fbtrace_id: "stub" } }));
    }
    const wamid = answer.wamid ?? `wamid.STUB${String(++seq).padStart(6, "0")}`;
    rec.wamid = wamid;
    return send(res, answer.httpStatus ?? 200, JSON.stringify({ messaging_product: "whatsapp", contacts: [{ input: to, wa_id: to }], messages: [{ id: wamid }] }));
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    answerNext: (...answers) => void queue.push(...answers),
    answerFor: (to, answer) => void byNumber.set(to, answer),
    reset: () => {
      requests.length = 0;
      queue = [];
      byNumber = new Map();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ── Webhooks back to our route (PR C5) ─────────────────────────────────

/** `X-Hub-Signature-256`: HMAC SHA256 of the raw body, keyed by the app secret. */
export function signWebhook(rawBody: string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

/** Meta's status update for one message (sent, delivered, read, failed). */
export function statusWebhookPayload(a: {
  phoneNumberId: string;
  wamid: string;
  recipient: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp?: Date;
  /** Echoed back as Meta does: we set it to the job id. */
  bizOpaqueCallbackData?: string;
  errors?: Array<{ code: number; title?: string; message?: string }>;
}): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "stub-waba",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "440000000000", phone_number_id: a.phoneNumberId },
              statuses: [
                {
                  id: a.wamid,
                  status: a.status,
                  timestamp: String(Math.floor((a.timestamp ?? new Date()).getTime() / 1000)),
                  recipient_id: a.recipient,
                  ...(a.bizOpaqueCallbackData ? { biz_opaque_callback_data: a.bizOpaqueCallbackData } : {}),
                  ...(a.errors ? { errors: a.errors } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Post a payload to a webhook URL signed as Meta signs it. Returns the HTTP status. */
export async function postSignedWebhook(a: { url: string; appSecret: string; payload: unknown; signature?: string }): Promise<number> {
  const raw = JSON.stringify(a.payload);
  const res = await fetch(a.url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": a.signature ?? signWebhook(raw, a.appSecret) },
    body: raw,
  });
  return res.status;
}
