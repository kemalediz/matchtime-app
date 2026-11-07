/**
 * THE CLOUD API CLIENT: one request to `POST /<PHONE_NUMBER_ID>/messages`
 * (WhatsApp Cloud API plan, PR C4). Plan: MDs/whatsapp-cloud-api-plan-
 * 2026-11-04.md, sections 1, 2 (step 13) and 5.9. A thin adapter: it
 * builds Meta's body, sends it and reports what came back as a
 * `CloudSendResult`. What that MEANS is `errors.ts`; what to send is
 * `dispatch.ts`.
 *
 *   WA_CLOUD_ACCESS_TOKEN      the system user token (secret: never logged,
 *                              never put in an error or a reason)
 *   WA_CLOUD_PHONE_NUMBER_ID   the official number's id
 *   WA_CLOUD_API_BASE          the local stub (e2e/stubs/cloud-api.ts),
 *                              honoured ONLY when the server was booted
 *                              with MT_TEST_MODE exactly "1". In test mode
 *                              with no stub, nothing is sent at all: the
 *                              real Meta is never called from a test.
 * The Graph version is the one constant below (plan section 1: v26.0).
 */
import type { CloudSendResult } from "./errors";

type Env = Record<string, string | undefined>;

export const CLOUD_GRAPH_VERSION = "v26.0";
export const META_GRAPH_BASE = "https://graph.facebook.com";
/** No answer in this long: `timeout` (it may have landed). */
export const CLOUD_SEND_TIMEOUT_MS = 15_000;

export interface CloudApiConfig {
  baseUrl: string;
  phoneNumberId: string;
  token: string;
}

/** The official number's settings, or null when it cannot send. */
export function cloudApiConfigFrom(env: Env = process.env): CloudApiConfig | null {
  const token = (env.WA_CLOUD_ACCESS_TOKEN ?? "").trim();
  const phoneNumberId = (env.WA_CLOUD_PHONE_NUMBER_ID ?? "").trim();
  if (!token || !phoneNumberId) return null;
  let baseUrl = META_GRAPH_BASE;
  if (env.MT_TEST_MODE === "1") {
    const stub = (env.WA_CLOUD_API_BASE ?? "").trim();
    if (!stub) return null;
    baseUrl = stub.replace(/\/+$/, "");
  }
  return { baseUrl, phoneNumberId, token };
}

/** One outgoing message. `jobId` is echoed back by Meta in status webhooks. */
export type CloudOutgoing =
  | { jobId: string; to: string; kind: "text"; text: string }
  | { jobId: string; to: string; kind: "template"; name: string; lang: string; components: unknown[] };

/** Meta's request body. Pure. */
export function cloudMessageBody(msg: CloudOutgoing): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: msg.to, biz_opaque_callback_data: msg.jobId };
  if (msg.kind === "text") return { ...base, type: "text", text: { body: msg.text } };
  return {
    ...base,
    type: "template",
    template: { name: msg.name, language: { code: msg.lang }, ...(msg.components.length > 0 ? { components: msg.components } : {}) },
  };
}

/** Connection errors that mean the request never reached the server. */
const NEVER_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

function errorCodeOf(err: unknown): string {
  const e = err as { code?: unknown; cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } };
  const code = e?.cause?.code ?? e?.code ?? e?.cause?.errors?.[0]?.code;
  return typeof code === "string" ? code : "unknown";
}

/** Send one message. Never throws. */
export async function sendCloudMessage(
  config: CloudApiConfig,
  msg: CloudOutgoing,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<CloudSendResult> {
  const url = `${config.baseUrl}/${CLOUD_GRAPH_VERSION}/${encodeURIComponent(config.phoneNumberId)}/messages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? CLOUD_SEND_TIMEOUT_MS);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify(cloudMessageBody(msg)),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.ok) {
      const id = (json as { messages?: Array<{ id?: unknown }> } | null)?.messages?.[0]?.id;
      return { kind: "accepted", wamid: typeof id === "string" && id ? id : null };
    }
    const e = (json as { error?: { code?: unknown; error_subcode?: unknown; message?: unknown } } | null)?.error;
    if (!e || typeof e !== "object") return { kind: "error", httpStatus: res.status, error: null };
    return {
      kind: "error",
      httpStatus: res.status,
      error: {
        code: typeof e.code === "number" ? e.code : null,
        subcode: typeof e.error_subcode === "number" ? e.error_subcode : null,
        message: typeof e.message === "string" ? e.message : null,
      },
    };
  } catch (err) {
    if (controller.signal.aborted) return { kind: "timeout" };
    const code = errorCodeOf(err);
    return NEVER_CONNECTED.has(code) ? { kind: "unreachable", reason: code } : { kind: "lost", reason: code };
  } finally {
    clearTimeout(timer);
  }
}
