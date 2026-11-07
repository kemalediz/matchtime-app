/**
 * THE CLOUD API CLIENT (WhatsApp Cloud API plan, PR C4, sections 1 and
 * 5.9): one request to `POST /<PHONE_NUMBER_ID>/messages`, against the
 * local stub (e2e/stubs/cloud-api.ts). Never Meta: the base URL override
 * is honoured only under MT_TEST_MODE=1, and test mode with no override
 * sends nothing at all.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import { startCloudApiStub, type CloudApiStub } from "../../../../e2e/stubs/cloud-api";
import { CLOUD_GRAPH_VERSION, META_GRAPH_BASE, cloudApiConfigFrom, cloudMessageBody, sendCloudMessage } from "../client";

const TOKEN = "EAAG-secret-token-never-logged";
let stub: CloudApiStub;

beforeAll(async () => {
  stub = await startCloudApiStub({ token: TOKEN });
});
afterAll(async () => {
  await stub.close();
});
afterEach(() => {
  stub.reset();
  vi.restoreAllMocks();
});

const testEnv = () => ({ MT_TEST_MODE: "1", WA_CLOUD_API_BASE: stub.url, WA_CLOUD_ACCESS_TOKEN: TOKEN, WA_CLOUD_PHONE_NUMBER_ID: "1234567890" });

describe("cloudApiConfigFrom", () => {
  it("needs the token and the phone number id", () => {
    expect(cloudApiConfigFrom({ WA_CLOUD_PHONE_NUMBER_ID: "1" })).toBeNull();
    expect(cloudApiConfigFrom({ WA_CLOUD_ACCESS_TOKEN: "t" })).toBeNull();
    expect(cloudApiConfigFrom({ WA_CLOUD_ACCESS_TOKEN: "t", WA_CLOUD_PHONE_NUMBER_ID: "1" })).toEqual({ baseUrl: META_GRAPH_BASE, phoneNumberId: "1", token: "t" });
  });

  it("ignores WA_CLOUD_API_BASE outside test mode: production always talks to Meta", () => {
    expect(cloudApiConfigFrom({ WA_CLOUD_API_BASE: "http://evil.example", WA_CLOUD_ACCESS_TOKEN: "t", WA_CLOUD_PHONE_NUMBER_ID: "1" })?.baseUrl).toBe(META_GRAPH_BASE);
    expect(cloudApiConfigFrom({ MT_TEST_MODE: "true", WA_CLOUD_API_BASE: "http://x", WA_CLOUD_ACCESS_TOKEN: "t", WA_CLOUD_PHONE_NUMBER_ID: "1" })?.baseUrl).toBe(META_GRAPH_BASE);
  });

  it("test mode uses the stub, and with no stub sends nothing (never Meta)", () => {
    expect(cloudApiConfigFrom(testEnv())?.baseUrl).toBe(stub.url);
    expect(cloudApiConfigFrom({ MT_TEST_MODE: "1", WA_CLOUD_ACCESS_TOKEN: "t", WA_CLOUD_PHONE_NUMBER_ID: "1" })).toBeNull();
  });

  it("the Graph version is one constant", () => {
    expect(CLOUD_GRAPH_VERSION).toBe("v26.0");
  });
});

describe("cloudMessageBody", () => {
  it("text: Meta's shape, with the job id echoed back in status webhooks", () => {
    expect(cloudMessageBody({ jobId: "pj1", to: "447700900001", kind: "text", text: "Hello" })).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "447700900001",
      biz_opaque_callback_data: "pj1",
      type: "text",
      text: { body: "Hello" },
    });
  });

  it("template: name, language and components", () => {
    const components = [{ type: "body", parameters: [{ type: "text", text: "Sutton FC" }] }];
    expect(cloudMessageBody({ jobId: "pj1", to: "447700900001", kind: "template", name: "mt_pool_offer", lang: "en_GB", components })).toMatchObject({
      type: "template",
      template: { name: "mt_pool_offer", language: { code: "en_GB" }, components },
    });
    expect(cloudMessageBody({ jobId: "pj1", to: "1", kind: "template", name: "mt_code", lang: "tr", components: [] })).toMatchObject({
      template: { name: "mt_code", language: { code: "tr" } },
    });
  });
});

describe("sendCloudMessage against the stub", () => {
  it("posts to /v26.0/<id>/messages with the token, and returns the wamid", async () => {
    const config = cloudApiConfigFrom(testEnv())!;
    const result = await sendCloudMessage(config, { jobId: "pj1", to: "447700900001", kind: "text", text: "Hello" });
    expect(result).toEqual({ kind: "accepted", wamid: expect.stringMatching(/^wamid\./) });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({ method: "POST", path: "/v26.0/1234567890/messages", authorised: true, body: { to: "447700900001", text: { body: "Hello" } } });
  });

  it("a Meta error comes back with its code", async () => {
    stub.answerNext({ httpStatus: 400, error: { code: 131047, message: "Re-engagement message" } });
    const result = await sendCloudMessage(cloudApiConfigFrom(testEnv())!, { jobId: "pj1", to: "1", kind: "text", text: "x" });
    expect(result).toEqual({ kind: "error", httpStatus: 400, error: { code: 131047, subcode: null, message: "Re-engagement message" } });
  });

  it("a 5xx with no Meta body", async () => {
    stub.answerNext({ httpStatus: 502, rawBody: "<html>bad gateway</html>" });
    const result = await sendCloudMessage(cloudApiConfigFrom(testEnv())!, { jobId: "pj1", to: "1", kind: "text", text: "x" });
    expect(result).toEqual({ kind: "error", httpStatus: 502, error: null });
  });

  it("no answer in time is a timeout", async () => {
    stub.answerNext({ delayMs: 500 });
    const result = await sendCloudMessage(cloudApiConfigFrom(testEnv())!, { jobId: "pj1", to: "1", kind: "text", text: "x" }, { timeoutMs: 50 });
    expect(result).toEqual({ kind: "timeout" });
  });

  it("a port nobody listens on is unreachable", async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const config = { ...cloudApiConfigFrom(testEnv())!, baseUrl: `http://127.0.0.1:${port}` };
    const result = await sendCloudMessage(config, { jobId: "pj1", to: "1", kind: "text", text: "x" });
    expect(result).toMatchObject({ kind: "unreachable" });
  });

  it("a wrong token is Meta's 401", async () => {
    const config = { ...cloudApiConfigFrom(testEnv())!, token: "wrong" };
    const result = await sendCloudMessage(config, { jobId: "pj1", to: "1", kind: "text", text: "x" });
    expect(result).toMatchObject({ kind: "error", httpStatus: 401, error: { code: 190 } });
    expect(stub.requests[0].authorised).toBe(false);
  });

  it("never logs or records the token", async () => {
    const logs: string[] = [];
    for (const m of ["log", "warn", "error", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    stub.answerNext({ httpStatus: 400, error: { code: 131026, message: "undeliverable" } });
    await sendCloudMessage(cloudApiConfigFrom(testEnv())!, { jobId: "pj1", to: "1", kind: "text", text: "x" });
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(JSON.stringify(stub.requests)).not.toContain(TOKEN);
  });
});
