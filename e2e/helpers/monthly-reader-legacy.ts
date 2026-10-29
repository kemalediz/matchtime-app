/**
 * The monthly reader's stub answers for every message the e2e suite posts
 * (2026-10-29). Production reads monthly lists and sign-ups with a model;
 * the scenarios written before that post real list text and expect what
 * the old code read from it. So, in the TEST process, each posted message
 * is read by the old code (`src/lib/__tests__/fixtures/monthly-legacy.ts`)
 * and its answer registered in the reader's stub file under `legacy`, keyed
 * by the body and the quoted text. The server only reads the answer: no
 * parsing code is reachable from production. A spec's own answers
 * (`setMonthlyReaderStub({ bodies })`) win over these.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { legacyReaderAnswer, readCollectorReply } from "@/lib/__tests__/fixtures/monthly-legacy";
import { E2E } from "./env";

const key = (body: string, quoted: string | null | undefined) => `${body.trim()}\u0000${(quoted ?? "").trim()}`;

function readStub(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(E2E.MONTHLY_READER_STUB_FILE, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Register the old code's reading of these messages. */
export function registerLegacyReadings(messages: Array<{ body?: unknown; quotedBody?: unknown }>): void {
  const stub = readStub();
  const legacy = { ...((stub.legacy as Record<string, unknown>) ?? {}) };
  let changed = false;
  for (const m of messages) {
    if (typeof m.body !== "string" || !m.body.trim()) continue;
    const quoted = typeof m.quotedBody === "string" ? m.quotedBody : null;
    const k = key(m.body, quoted);
    if (k in legacy) continue;
    legacy[k] = legacyReaderAnswer(m.body, quoted);
    changed = true;
  }
  if (!changed) return;
  mkdirSync(path.dirname(E2E.MONTHLY_READER_STUB_FILE), { recursive: true });
  writeFileSync(E2E.MONTHLY_READER_STUB_FILE, JSON.stringify({ ...stub, legacy }, null, 2));
}

/** The collector's answer to the paid-claims list, as the old fixed
 *  words read it, registered in the digest reader's stub (a spec's own
 *  answers win). Unregistered: the model says "other". */
export function registerLegacyDigestReplies(bodies: string[]): void {
  let stub: { bodies?: Record<string, string>; fail?: string[] } = {};
  try {
    stub = JSON.parse(readFileSync(E2E.DIGEST_REPLY_STUB_FILE, "utf8"));
  } catch {
    stub = {};
  }
  const out = { ...(stub.bodies ?? {}) };
  let changed = false;
  for (const b of bodies) {
    const key = b.trim();
    if (!key || key in out) continue;
    const r = readCollectorReply(b);
    if (!r) continue;
    out[key] = JSON.stringify({ answer: r.kind, numbers: r.kind === "numbers" ? r.numbers : [], month: r.month ?? 0, confidence: 1 });
    changed = true;
  }
  if (!changed) return;
  mkdirSync(path.dirname(E2E.DIGEST_REPLY_STUB_FILE), { recursive: true });
  writeFileSync(E2E.DIGEST_REPLY_STUB_FILE, JSON.stringify({ ...stub, bodies: out }, null, 2));
}

/**
 * The request fixture, wrapped: a post to the players' group route or the
 * admin group route registers its messages' legacy readings first.
 */
export function withLegacyMonthlyReadings(request: APIRequestContext): APIRequestContext {
  return new Proxy(request, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "post" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      return (url: string, options?: { data?: unknown }) => {
        const data = options?.data as { messages?: Array<{ body?: unknown; quotedBody?: unknown }>; text?: unknown } | undefined;
        if (typeof url === "string" && url.includes("/api/whatsapp/analyze") && Array.isArray(data?.messages)) registerLegacyReadings(data.messages);
        if (typeof url === "string" && url.includes("/api/whatsapp/admin-group") && typeof data?.text === "string") {
          registerLegacyReadings([{ body: data.text }]);
          registerLegacyDigestReplies([data.text]);
        }
        const dmBody = (data as { body?: unknown } | undefined)?.body;
        if (typeof url === "string" && url.includes("/api/whatsapp/dm-reply") && typeof dmBody === "string") registerLegacyDigestReplies([dmBody]);
        return (value as (u: string, o?: unknown) => unknown).call(target, url, options);
      };
    },
  });
}
