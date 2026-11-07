/**
 * The owner page's "Access token check": what Meta says about the access
 * token (`GET /debug_token`, asked with the app's own token) and whether the
 * token can see the official number (`GET /<PHONE_NUMBER_ID>`). Only facts
 * that are not secret come back. Every test runs on a stubbed fetch: nothing
 * here reaches Meta, and the real fetch is refused inside a test run.
 */
import { describe, expect, it, vi } from "vitest";
import { checkAccessToken } from "../token-check";

const TOKEN = "EAAG-secret-token-value";
const SECRET = "app-secret-abc123";
const APP_ID = "3717715315059721";
const ENV = {
  WA_CLOUD_ACCESS_TOKEN: TOKEN,
  WA_CLOUD_APP_ID: APP_ID,
  WA_CLOUD_APP_SECRET: SECRET,
  WA_CLOUD_WABA_ID: "1566680795216924",
  WA_CLOUD_PHONE_NUMBER_ID: "555000111",
};

const DEBUG_OK = {
  data: {
    app_id: APP_ID,
    type: "SYSTEM_USER",
    application: "MatchTime",
    data_access_expires_at: 0,
    expires_at: 0,
    is_valid: true,
    issued_at: 1762300000,
    scopes: ["whatsapp_business_management", "whatsapp_business_messaging", "public_profile"],
    granular_scopes: [
      { scope: "whatsapp_business_management", target_ids: ["999888777"] },
      { scope: "whatsapp_business_messaging", target_ids: ["999888777"] },
    ],
    user_id: "122100000000000001",
  },
};

const PHONE_OK = { id: "555000111", display_phone_number: "+44 7700 900000", verified_name: "MatchTime" };

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function stub(debug: Route, phone: Route) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const u = new URL(url);
    return u.pathname.endsWith("/debug_token") ? debug(u, init) : phone(u, init);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, spy: fetch };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Everything the page could show, as one string. */
const shown = (r: unknown) => JSON.stringify(r);

describe("checkAccessToken: what Meta says about the token", () => {
  it("shows the token's non-secret facts from debug_token", async () => {
    const s = stub(
      () => json(DEBUG_OK),
      () => json(PHONE_OK),
    );
    const r = await checkAccessToken({ fetch: s.fetch, env: ENV });
    expect(r.debug).toEqual({
      state: "ok",
      info: {
        isValid: true,
        appId: APP_ID,
        type: "SYSTEM_USER",
        application: "MatchTime",
        expiresAt: 0,
        dataAccessExpiresAt: 0,
        issuedAt: 1762300000,
        scopes: ["whatsapp_business_management", "whatsapp_business_messaging", "public_profile"],
        granularScopes: [
          { scope: "whatsapp_business_management", targetIds: ["999888777"] },
          { scope: "whatsapp_business_messaging", targetIds: ["999888777"] },
        ],
        userId: "122100000000000001",
        error: null,
        wabaInTargets: false,
      },
    });
  });

  it("asks debug_token with the app's own token, GET only, on the template sync's Graph version", async () => {
    const s = stub(
      () => json(DEBUG_OK),
      () => json(PHONE_OK),
    );
    const r = await checkAccessToken({ fetch: s.fetch, env: { ...ENV, WA_CLOUD_GRAPH_VERSION: "v25.0" } });
    expect(r.graphVersion).toBe("v25.0");
    const debug = new URL(s.calls.find((c) => c.url.includes("/debug_token"))!.url);
    expect(debug.origin).toBe("https://graph.facebook.com");
    expect(debug.pathname).toBe("/v25.0/debug_token");
    expect(debug.searchParams.get("input_token")).toBe(TOKEN);
    expect(debug.searchParams.get("access_token")).toBe(`${APP_ID}|${SECRET}`);
    expect(s.calls.every((c) => (c.init?.method ?? "GET") === "GET")).toBe(true);
    expect((await checkAccessToken({ fetch: s.fetch, env: ENV })).graphVersion).toBe("v26.0");
  });

  it("says whether the WhatsApp Business Account id is among the granted targets", async () => {
    const withWaba = {
      data: { ...DEBUG_OK.data, granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["1566680795216924"] }] },
    };
    const s = stub(
      () => json(withWaba),
      () => json(PHONE_OK),
    );
    const r = await checkAccessToken({ fetch: s.fetch, env: ENV });
    expect(r.debug.state === "ok" && r.debug.info.wabaInTargets).toBe(true);
  });

  it("shows an invalid token's error from Meta, and expires_at as Meta gave it", async () => {
    const bad = {
      data: { app_id: APP_ID, is_valid: false, expires_at: 1762000000, scopes: [], error: { code: 190, subcode: 463, message: "Session has expired" } },
    };
    const s = stub(
      () => json(bad),
      () => json(PHONE_OK),
    );
    const r = await checkAccessToken({ fetch: s.fetch, env: ENV });
    expect(r.debug).toMatchObject({
      state: "ok",
      info: { isValid: false, expiresAt: 1762000000, error: { code: 190, subcode: 463, message: "Session has expired" } },
    });
  });

  it("surfaces debug_token's own failure with Meta's code and message", async () => {
    const s = stub(
      () => json({ error: { message: "Invalid OAuth access token signature.", type: "OAuthException", code: 190, fbtrace_id: "AbC" } }, 400),
      () => json(PHONE_OK),
    );
    const r = await checkAccessToken({ fetch: s.fetch, env: ENV });
    expect(r.debug).toEqual({ state: "error", message: expect.stringContaining("Invalid OAuth access token signature.") });
    expect(r.debug.state === "error" && r.debug.message).toMatch(/HTTP 400.*190/);
  });

  it("skips debug_token, calling nobody for it, when the app id or secret is missing", async () => {
    const s = stub(
      () => json(DEBUG_OK),
      () => json(PHONE_OK),
    );
    const r = await checkAccessToken({ fetch: s.fetch, env: { ...ENV, WA_CLOUD_APP_ID: undefined } });
    expect(r.debug).toEqual({ state: "skipped", reason: expect.stringContaining("WA_CLOUD_APP_ID") });
    expect(s.calls.some((c) => c.url.includes("/debug_token"))).toBe(false);
    const r2 = await checkAccessToken({ fetch: s.fetch, env: { ...ENV, WA_CLOUD_APP_SECRET: " " } });
    expect(r2.debug).toEqual({ state: "skipped", reason: expect.stringContaining("WA_CLOUD_APP_SECRET") });
  });
});

describe("checkAccessToken: can the token see the official number", () => {
  it("shows the number's id, display number and verified name, asked with the access token as a header", async () => {
    const s = stub(
      () => json(DEBUG_OK),
      () => json(PHONE_OK),
    );
    const r = await checkAccessToken({ fetch: s.fetch, env: ENV });
    expect(r.phone).toEqual({ state: "ok", id: "555000111", displayPhoneNumber: "+44 7700 900000", verifiedName: "MatchTime" });
    const call = s.calls.find((c) => !c.url.includes("/debug_token"))!;
    const u = new URL(call.url);
    expect(u.pathname).toBe("/v26.0/555000111");
    expect(u.searchParams.get("fields")).toBe("id,display_phone_number,verified_name");
    expect(u.searchParams.has("access_token")).toBe(false);
    expect((call.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("surfaces Meta's error when the token cannot see the number", async () => {
    const s = stub(
      () => json(DEBUG_OK),
      () =>
        json(
          {
            error: {
              message: "Unsupported get request. Object with ID '555000111' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
              type: "GraphMethodException",
              code: 100,
              error_subcode: 33,
              fbtrace_id: "XyZ",
            },
          },
          400,
        ),
    );
    const r = await checkAccessToken({ fetch: s.fetch, env: ENV });
    expect(r.phone.state).toBe("error");
    if (r.phone.state !== "error") return;
    expect(r.phone.message).toContain("Unsupported get request");
    expect(r.phone.message).toMatch(/HTTP 400 100/);
    expect(r.phone.message).toContain("subcode 33");
    expect(r.phone.message).toContain("fbtrace_id XyZ");
  });

  it("skips the number, calling nobody for it, when the phone number id is missing", async () => {
    const s = stub(
      () => json(DEBUG_OK),
      () => json(PHONE_OK),
    );
    const r = await checkAccessToken({ fetch: s.fetch, env: { ...ENV, WA_CLOUD_PHONE_NUMBER_ID: "" } });
    expect(r.phone).toEqual({ state: "skipped", reason: expect.stringContaining("WA_CLOUD_PHONE_NUMBER_ID") });
    expect(s.calls.length).toBe(1);
  });

  it("calls nobody at all when the access token is missing", async () => {
    const s = stub(
      () => json(DEBUG_OK),
      () => json(PHONE_OK),
    );
    const r = await checkAccessToken({ fetch: s.fetch, env: { ...ENV, WA_CLOUD_ACCESS_TOKEN: undefined } });
    expect(r.debug.state).toBe("skipped");
    expect(r.phone.state).toBe("skipped");
    expect(s.spy).not.toHaveBeenCalled();
  });
});

describe("checkAccessToken: the settings, never their values", () => {
  it("lists each setting as present or not, with its length only", async () => {
    const s = stub(
      () => json(DEBUG_OK),
      () => json(PHONE_OK),
    );
    const r = await checkAccessToken({ fetch: s.fetch, env: { ...ENV, WA_CLOUD_VERIFY_TOKEN: undefined } });
    expect(r.env).toContainEqual({ name: "WA_CLOUD_ACCESS_TOKEN", present: true, length: TOKEN.length, outerWhitespace: false });
    expect(r.env).toContainEqual({ name: "WA_CLOUD_APP_SECRET", present: true, length: SECRET.length, outerWhitespace: false });
    expect(r.env).toContainEqual({ name: "WA_CLOUD_APP_ID", present: true, length: APP_ID.length, outerWhitespace: false });
    expect(r.env).toContainEqual({ name: "WA_CLOUD_VERIFY_TOKEN", present: false, length: 0, outerWhitespace: false });
    for (const name of ["WA_CLOUD_WABA_ID", "WA_CLOUD_PHONE_NUMBER_ID", "WA_CLOUD_GRAPH_VERSION", "WA_CLOUD_NUMBER", "WA_CLOUD_API_BASE"]) {
      expect(r.env.map((e) => e.name)).toContain(name);
    }
    // No value of any setting appears among the env rows.
    const rows = JSON.stringify(r.env);
    for (const v of Object.values(ENV)) expect(rows).not.toContain(v);
  });

  it("detects leading or trailing whitespace and a newline on the token, and still asks Meta with it trimmed", async () => {
    const s = stub(
      () => json(DEBUG_OK),
      () => json(PHONE_OK),
    );
    const r = await checkAccessToken({ fetch: s.fetch, env: { ...ENV, WA_CLOUD_ACCESS_TOKEN: `${TOKEN}\n` } });
    expect(r.token).toEqual({ outerWhitespace: true, newline: true });
    expect(new URL(s.calls[0].url).searchParams.get("input_token")).toBe(TOKEN);

    const lead = await checkAccessToken({ fetch: s.fetch, env: { ...ENV, WA_CLOUD_ACCESS_TOKEN: ` ${TOKEN}` } });
    expect(lead.token).toEqual({ outerWhitespace: true, newline: false });

    const clean = await checkAccessToken({ fetch: s.fetch, env: ENV });
    expect(clean.token).toEqual({ outerWhitespace: false, newline: false });
  });
});

describe("checkAccessToken: secrets never come back", () => {
  it("scrubs the token, the app secret and the app token out of a network error", async () => {
    const s = stub(
      (u) => {
        throw new Error(`connect failed for ${u.toString()} (secret ${SECRET})`);
      },
      () => {
        throw new Error(`connect failed, token ${TOKEN}`);
      },
    );
    const r = await checkAccessToken({ fetch: s.fetch, env: { ...ENV, WA_CLOUD_ACCESS_TOKEN: ` ${TOKEN}\n` } });
    expect(r.debug.state).toBe("error");
    expect(r.phone.state).toBe("error");
    expect(shown(r)).not.toContain(TOKEN);
    expect(shown(r)).not.toContain(SECRET);
    expect(shown(r)).not.toContain(encodeURIComponent(`${APP_ID}|${SECRET}`));
  });

  it("scrubs them even when Meta's own answer echoes them back", async () => {
    const s = stub(
      () => json({ error: { message: `bad input_token ${TOKEN} for app token ${APP_ID}|${SECRET}`, code: 190 } }, 400),
      () => json({ id: "555000111", display_phone_number: TOKEN, verified_name: SECRET }),
    );
    const r = await checkAccessToken({ fetch: s.fetch, env: ENV });
    expect(shown(r)).not.toContain(TOKEN);
    expect(shown(r)).not.toContain(SECRET);
  });

  it("logs nothing that carries a secret", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = stub(
        () => json({ error: { message: `nope ${TOKEN}`, code: 190 } }, 400),
        () => {
          throw new Error(`down ${TOKEN} ${SECRET}`);
        },
      );
      await checkAccessToken({ fetch: s.fetch, env: ENV });
      const all = JSON.stringify([log.mock.calls, err.mock.calls, warn.mock.calls]);
      expect(all).not.toContain(TOKEN);
      expect(all).not.toContain(SECRET);
    } finally {
      log.mockRestore();
      err.mockRestore();
      warn.mockRestore();
    }
  });

  it("never takes the real fetch inside a test run, even with a made-up env", async () => {
    const real = globalThis.fetch;
    const spy = vi.fn(async () => new Response("{}", { status: 500 }));
    globalThis.fetch = spy as unknown as typeof globalThis.fetch;
    try {
      const r = await checkAccessToken({ fetch: globalThis.fetch, env: ENV });
      expect(r.debug).toEqual({ state: "error", message: expect.stringMatching(/real fetch/) });
      expect(r.phone).toEqual({ state: "error", message: expect.stringMatching(/real fetch/) });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = real;
    }
  });

  it("with no deps given, still never reaches the network in a test run", async () => {
    const real = globalThis.fetch;
    const spy = vi.fn(async () => new Response("{}", { status: 500 }));
    globalThis.fetch = spy as unknown as typeof globalThis.fetch;
    try {
      await checkAccessToken();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = real;
    }
  });
});
