/**
 * The access token check's read-only PROBES: GETs, with the access token,
 * on the WhatsApp Business Account (its fields, its numbers, its templates,
 * its subscribed apps), on the number's link to its account, and on the
 * token's own user, on the configured Graph version and on v27.0. Each one
 * shows Meta's status, code, subcode, type, fbtrace_id and message, or the
 * non-secret answer. Every test runs on a stubbed fetch: nothing here
 * reaches Meta, and the real fetch is refused inside a test run.
 */
import { describe, expect, it, vi } from "vitest";
import { checkAccessToken, PROBE_NEWER_GRAPH_VERSION, type Probe } from "../token-check";

const TOKEN = "EAAG-secret-token-value";
const SECRET = "app-secret-abc123";
const APP_ID = "3717715315059721";
const WABA = "1566680795216924";
const PHONE = "555000111";
const ENV = {
  WA_CLOUD_ACCESS_TOKEN: TOKEN,
  WA_CLOUD_APP_ID: APP_ID,
  WA_CLOUD_APP_SECRET: SECRET,
  WA_CLOUD_WABA_ID: WABA,
  WA_CLOUD_PHONE_NUMBER_ID: PHONE,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const NOT_FOUND = {
  error: {
    message: `Unsupported get request. Object with ID '${WABA}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
    type: "GraphMethodException",
    code: 100,
    error_subcode: 33,
    fbtrace_id: "AbCdEf123",
  },
};

/** Meta's answers by path (the version taken off), with a fallback. */
type Answer = (u: URL) => Response;
function stub(answers: Record<string, Answer> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v[\d.]+/, "");
    const answer = answers[path];
    if (answer) return answer(u);
    if (path === "/debug_token") return json({ data: { is_valid: true, app_id: APP_ID } });
    return json({ id: "x" });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, spy: fetch };
}

const probe = (probes: Probe[], id: string, version: string) => probes.find((p) => p.id === id && p.version === version);

describe("checkAccessToken probes: which GETs are asked, where and how", () => {
  it("asks every probe, GET only, with the token as a header, on the configured version and on v27.0", async () => {
    const s = stub();
    const r = await checkAccessToken({ fetch: s.fetch, env: ENV });
    expect(PROBE_NEWER_GRAPH_VERSION).toBe("v27.0");
    expect(r.probes.map((p) => `${p.id}@${p.version}`)).toEqual([
      "waba@v26.0",
      "waba@v27.0",
      "waba-phone-numbers@v26.0",
      "waba-phone-numbers@v27.0",
      "waba-templates@v27.0",
      "phone-waba@v26.0",
      "me@v26.0",
      "waba-subscribed-apps@v26.0",
      "waba-subscribed-apps@v27.0",
    ]);

    const urls = s.calls.map((c) => new URL(c.url)).filter((u) => !u.pathname.endsWith("/debug_token"));
    const asked = urls.map((u) => `${u.pathname}?${u.searchParams.toString()}`);
    expect(asked).toEqual(
      expect.arrayContaining([
        `/v26.0/${WABA}?fields=${encodeURIComponent("id,name,currency,timezone_id,message_template_namespace")}`,
        `/v27.0/${WABA}?fields=${encodeURIComponent("id,name,currency,timezone_id,message_template_namespace")}`,
        `/v26.0/${WABA}/phone_numbers?fields=${encodeURIComponent("id,display_phone_number")}`,
        `/v27.0/${WABA}/phone_numbers?fields=${encodeURIComponent("id,display_phone_number")}`,
        `/v27.0/${WABA}/message_templates?limit=1&fields=${encodeURIComponent("name,status")}`,
        `/v26.0/${PHONE}?fields=${encodeURIComponent("id,whatsapp_business_account")}`,
        `/v26.0/me?fields=${encodeURIComponent("id,name")}`,
        `/v26.0/${WABA}/subscribed_apps?`,
        `/v27.0/${WABA}/subscribed_apps?`,
      ]),
    );
    // Never on the app's own id: subscribed_apps is asked on the account.
    expect(urls.some((u) => u.pathname.includes(APP_ID))).toBe(false);
    for (const c of s.calls) {
      expect(c.init?.method).toBe("GET");
      expect(c.init?.body).toBeUndefined();
    }
    for (const c of s.calls.filter((c) => !c.url.includes("/debug_token"))) {
      expect(new URL(c.url).searchParams.has("access_token")).toBe(false);
      expect((c.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("asks only once per probe when the configured version is already v27.0", async () => {
    const s = stub();
    const r = await checkAccessToken({ fetch: s.fetch, env: { ...ENV, WA_CLOUD_GRAPH_VERSION: "v27.0" } });
    expect(r.probes.map((p) => `${p.id}@${p.version}`)).toEqual([
      "waba@v27.0",
      "waba-phone-numbers@v27.0",
      "waba-templates@v27.0",
      "phone-waba@v27.0",
      "me@v27.0",
      "waba-subscribed-apps@v27.0",
    ]);
  });

  it("shows the path asked, with no token in it", async () => {
    const s = stub();
    const r = await checkAccessToken({ fetch: s.fetch, env: ENV });
    expect(probe(r.probes, "waba-templates", "v27.0")?.path).toBe(`/${WABA}/message_templates?limit=1&fields=name,status`);
    expect(probe(r.probes, "me", "v26.0")?.path).toBe("/me?fields=id,name");
  });
});

describe("checkAccessToken probes: Meta's error fields, in full", () => {
  it("shows status, code, subcode, type, fbtrace_id and message for the failing template listing on v27.0", async () => {
    const s = stub({ [`/${WABA}/message_templates`]: () => json(NOT_FOUND, 400) });
    const r = await checkAccessToken({ fetch: s.fetch, env: ENV });
    expect(probe(r.probes, "waba-templates", "v27.0")?.outcome).toEqual({
      state: "error",
      error: {
        status: 400,
        code: 100,
        subcode: 33,
        type: "GraphMethodException",
        fbtraceId: "AbCdEf123",
        message: NOT_FOUND.error.message,
      },
    });
  });

  it("tells the two versions apart when only one of them fails", async () => {
    const s = stub({ [`/${WABA}`]: (u) => (u.pathname.startsWith("/v26.0/") ? json(NOT_FOUND, 400) : json({ id: WABA, name: "Cressoft Consultancy Limited" })) });
    const r = await checkAccessToken({ fetch: s.fetch, env: ENV });
    expect(probe(r.probes, "waba", "v26.0")?.outcome.state).toBe("error");
    expect(probe(r.probes, "waba", "v27.0")?.outcome).toMatchObject({ state: "ok", status: 200 });
  });

  it("shows Meta's error for the number's unknown account field, as Meta gave it", async () => {
    const unknown = { error: { message: "(#100) Tried accessing nonexisting field (whatsapp_business_account)", type: "OAuthException", code: 100, fbtrace_id: "Q1" } };
    const s = stub({ [`/${PHONE}`]: (u) => (u.searchParams.get("fields")?.includes("whatsapp_business_account") ? json(unknown, 400) : json({ id: PHONE })) });
    const r = await checkAccessToken({ fetch: s.fetch, env: ENV });
    expect(probe(r.probes, "phone-waba", "v26.0")?.outcome).toEqual({
      state: "error",
      error: { status: 400, code: 100, subcode: null, type: "OAuthException", fbtraceId: "Q1", message: unknown.error.message },
    });
  });

  it("keeps the HTTP status when Meta's body is not JSON", async () => {
    const s = stub({ "/me": () => new Response("<html>bad gateway</html>", { status: 502 }) });
    const r = await checkAccessToken({ fetch: s.fetch, env: ENV });
    expect(probe(r.probes, "me", "v26.0")?.outcome).toEqual({
      state: "error",
      error: { status: 502, code: null, subcode: null, type: null, fbtraceId: null, message: "no JSON error body" },
    });
  });

  it("shows a network failure with no status", async () => {
    const s = stub({
      "/me": () => {
        throw new Error("socket hang up");
      },
    });
    const r = await checkAccessToken({ fetch: s.fetch, env: ENV });
    expect(probe(r.probes, "me", "v26.0")?.outcome).toEqual({
      state: "error",
      error: { status: null, code: null, subcode: null, type: null, fbtraceId: null, message: "socket hang up" },
    });
  });
});

describe("checkAccessToken probes: the non-secret answer", () => {
  it("shows the account's fields, the numbers, the templates page and the token's user, without paging links", async () => {
    const s = stub({
      [`/${WABA}`]: () => json({ id: WABA, name: "Cressoft Consultancy Limited", currency: "GBP", timezone_id: "71", message_template_namespace: "ns_1" }),
      [`/${WABA}/phone_numbers`]: () =>
        json({
          data: [{ id: PHONE, display_phone_number: "+44 7782 214985" }],
          paging: { cursors: { before: "b", after: "a" }, next: `https://graph.facebook.com/v26.0/${WABA}/phone_numbers?access_token=${TOKEN}&after=a` },
        }),
      [`/${WABA}/message_templates`]: () => json({ data: [{ name: "mt_pool_offer", status: "APPROVED", id: "9" }], paging: { cursors: { after: "z" } } }),
      "/me": () => json({ id: "122100000000000001", name: "MatchTime System User" }),
    });
    const r = await checkAccessToken({ fetch: s.fetch, env: ENV });
    const result = (id: string, v: string) => {
      const o = probe(r.probes, id, v)?.outcome;
      return o?.state === "ok" ? o.result : null;
    };
    expect(result("waba", "v26.0")).toBe(
      JSON.stringify({ id: WABA, name: "Cressoft Consultancy Limited", currency: "GBP", timezone_id: "71", message_template_namespace: "ns_1" }),
    );
    expect(result("waba-phone-numbers", "v27.0")).toBe(JSON.stringify({ data: [{ id: PHONE, display_phone_number: "+44 7782 214985" }] }));
    expect(result("waba-templates", "v27.0")).toBe(JSON.stringify({ data: [{ name: "mt_pool_offer", status: "APPROVED", id: "9" }] }));
    expect(result("me", "v26.0")).toBe(JSON.stringify({ id: "122100000000000001", name: "MatchTime System User" }));
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain("paging");
  });

  it("says whether our app (WA_CLOUD_APP_ID) is among the account's subscribed apps", async () => {
    const ours = { data: [{ whatsapp_business_api_data: { id: APP_ID, name: "MatchTime", link: "https://www.facebook.com/games/?app_id=1" } }] };
    const s = stub({
      [`/${WABA}/subscribed_apps`]: (u) => (u.pathname.startsWith("/v26.0/") ? json(ours) : json({ data: [] })),
    });
    const r = await checkAccessToken({ fetch: s.fetch, env: ENV });
    expect(probe(r.probes, "waba-subscribed-apps", "v26.0")?.outcome).toMatchObject({ state: "ok", note: "WA_CLOUD_APP_ID subscribed: yes" });
    expect(probe(r.probes, "waba-subscribed-apps", "v27.0")?.outcome).toMatchObject({ state: "ok", note: "WA_CLOUD_APP_ID subscribed: no", result: '{"data":[]}' });
  });

  it("caps a long answer so the table stays readable", async () => {
    const s = stub({ "/me": () => json({ id: "1", name: "x".repeat(5000) }) });
    const r = await checkAccessToken({ fetch: s.fetch, env: ENV });
    const o = probe(r.probes, "me", "v26.0")?.outcome;
    expect(o?.state === "ok" && o.result.length).toBeLessThanOrEqual(1001);
  });
});

describe("checkAccessToken probes: skipped, never guessed", () => {
  it("asks no probe without a token", async () => {
    const s = stub();
    const r = await checkAccessToken({ fetch: s.fetch, env: { ...ENV, WA_CLOUD_ACCESS_TOKEN: "" } });
    expect(s.spy).not.toHaveBeenCalled();
    expect(r.probes.length).toBeGreaterThan(0);
    for (const p of r.probes) expect(p.outcome).toEqual({ state: "skipped", reason: "WA_CLOUD_ACCESS_TOKEN is not set" });
  });

  it("skips the account's probes without WA_CLOUD_WABA_ID, and the number's without WA_CLOUD_PHONE_NUMBER_ID", async () => {
    const s = stub();
    const r = await checkAccessToken({ fetch: s.fetch, env: { ...ENV, WA_CLOUD_WABA_ID: " ", WA_CLOUD_PHONE_NUMBER_ID: undefined } });
    for (const p of r.probes.filter((p) => p.id.startsWith("waba"))) expect(p.outcome).toEqual({ state: "skipped", reason: "WA_CLOUD_WABA_ID is not set" });
    expect(probe(r.probes, "phone-waba", "v26.0")?.outcome).toEqual({ state: "skipped", reason: "WA_CLOUD_PHONE_NUMBER_ID is not set" });
    expect(probe(r.probes, "me", "v26.0")?.outcome.state).toBe("ok");
    const paths = s.calls.map((c) => new URL(c.url).pathname);
    expect(paths.every((p) => p.endsWith("/debug_token") || p.endsWith("/me"))).toBe(true);
  });
});

describe("checkAccessToken probes: secrets never come back", () => {
  it("scrubs the token and the app secret out of Meta's errors, answers and network failures", async () => {
    const s = stub({
      [`/${WABA}`]: () => json({ error: { message: `bad token ${TOKEN} and ${APP_ID}|${SECRET}`, code: 190, fbtrace_id: TOKEN } }, 400),
      "/me": () => json({ id: "1", name: TOKEN }),
      [`/${WABA}/subscribed_apps`]: () => {
        throw new Error(`down ${TOKEN} ${SECRET}`);
      },
    });
    const r = await checkAccessToken({ fetch: s.fetch, env: { ...ENV, WA_CLOUD_ACCESS_TOKEN: ` ${TOKEN}\n` } });
    const shown = JSON.stringify(r);
    expect(shown).not.toContain(TOKEN);
    expect(shown).not.toContain(SECRET);
    expect(probe(r.probes, "waba", "v26.0")?.outcome).toMatchObject({ state: "error", error: { code: 190 } });
  });

  it("logs nothing that carries a secret", async () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const s = stub({ "/me": () => json({ error: { message: `nope ${TOKEN}`, code: 190 } }, 400) });
      await checkAccessToken({ fetch: s.fetch, env: ENV });
      const all = JSON.stringify(spies.map((sp) => sp.mock.calls));
      expect(all).not.toContain(TOKEN);
      expect(all).not.toContain(SECRET);
    } finally {
      for (const sp of spies) sp.mockRestore();
    }
  });

  it("never takes the real fetch inside a test run", async () => {
    const real = globalThis.fetch;
    const spy = vi.fn(async () => new Response("{}", { status: 500 }));
    globalThis.fetch = spy as unknown as typeof globalThis.fetch;
    try {
      const r = await checkAccessToken({ fetch: globalThis.fetch, env: ENV });
      expect(spy).not.toHaveBeenCalled();
      for (const p of r.probes) expect(p.outcome).toEqual({ state: "error", error: expect.objectContaining({ message: expect.stringMatching(/real fetch/) }) });
    } finally {
      globalThis.fetch = real;
    }
  });
});
