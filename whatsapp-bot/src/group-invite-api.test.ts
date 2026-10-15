import { afterEach, describe, expect, it, vi } from "vitest";
import { postGroupInviteCheck } from "./group-invite-api.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("postGroupInviteCheck", () => {
  it("posts the sender to /api/whatsapp/group-invite with the bot key, and reads the answer", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ accept: true, match: "lid" }), { status: 200 }));
    const out = await postGroupInviteCheck({ senderLid: "158055467598961", kind: "invite-message" }, fetchFn);
    expect(out).toEqual({ accept: true, match: "lid" });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/whatsapp\/group-invite$/);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBeDefined();
    expect(JSON.parse(String(init.body))).toEqual({ senderLid: "158055467598961", kind: "invite-message" });
  });

  it("is null on a non-200, a network failure, or a body that is not an answer", async () => {
    expect(await postGroupInviteCheck({ kind: "invite-link" }, vi.fn(async () => new Response("no", { status: 500 })))).toBeNull();
    expect(
      await postGroupInviteCheck(
        { kind: "invite-link" },
        vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      ),
    ).toBeNull();
    expect(
      await postGroupInviteCheck({ kind: "invite-link" }, vi.fn(async () => new Response('{"shadowMode":true}', { status: 200 }))),
    ).toBeNull();
  });
});
