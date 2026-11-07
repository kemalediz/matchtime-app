/**
 * The owner's "WhatsApp templates" page runs `syncTemplates` on the server,
 * where the access token lives (it is a Vercel secret, never pulled
 * locally). These pin the server half: a dry run only ever reads, Submit
 * posts, a missing setting calls nobody, and the token never comes back in
 * anything the page or the browser could show. Every test runs on a
 * stubbed fetch: nothing here reaches Meta.
 */
import { describe, expect, it, vi } from "vitest";
import { CLOUD_TEMPLATES, META_LANG, metaComponents } from "../templates";
import type { MetaTemplate } from "../template-sync";
import { checkCloudTemplates, submitCloudTemplates } from "../template-sync-admin";

const TOKEN = "EAAG-secret-token-value";
const ENV = { WA_CLOUD_WABA_ID: "1234", WA_CLOUD_ACCESS_TOKEN: TOKEN, WA_CLOUD_GRAPH_VERSION: "v26.0" };

function asMeta(name: string, lang: "en" | "tr", over: Partial<MetaTemplate> = {}): MetaTemplate {
  const t = CLOUD_TEMPLATES.find((x) => x.name === name)!;
  return { id: `id_${name}_${lang}`, name, language: META_LANG[lang], status: "APPROVED", category: t.category, components: metaComponents(t.name, lang), ...over };
}

function stubFetch(held: MetaTemplate[], opts: { failPost?: boolean } = {}) {
  const methods: string[] = [];
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    methods.push(method);
    if (method === "GET") return new Response(JSON.stringify({ data: held, paging: {} }), { status: 200 });
    if (opts.failPost) return new Response(JSON.stringify({ error: { message: "Invalid parameter", code: 100 } }), { status: 400 });
    return new Response(JSON.stringify({ id: "new_id", status: "PENDING" }), { status: 200 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, methods, spy: fetch };
}

/** Everything held as is, except one template missing in Turkish. */
const ALL_BUT_ONE = CLOUD_TEMPLATES.flatMap((t) => (["en", "tr"] as const).map((l) => asMeta(t.name, l))).filter(
  (m) => !(m.name === "mt_pool_offer" && m.language === "tr"),
);

describe("checkCloudTemplates (the page's dry run)", () => {
  it("reads Meta's list and never POSTs", async () => {
    const s = stubFetch(ALL_BUT_ONE);
    const r = await checkCloudTemplates({ fetch: s.fetch, env: ENV });
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.diffs.find((d) => d.name === "mt_pool_offer" && d.language === "tr")).toMatchObject({ kind: "new" });
    expect(r.diffs.filter((d) => d.kind === "same").length).toBe(ALL_BUT_ONE.length);
    expect(s.methods.length).toBeGreaterThan(0);
    expect(s.methods.every((m) => m === "GET")).toBe(true);
  });

  it("calls nobody when the WhatsApp Business Account or the token is not set", async () => {
    const s = stubFetch([]);
    expect(await checkCloudTemplates({ fetch: s.fetch, env: { WA_CLOUD_WABA_ID: "1234" } })).toEqual({ state: "not-configured" });
    expect(await checkCloudTemplates({ fetch: s.fetch, env: { WA_CLOUD_ACCESS_TOKEN: TOKEN } })).toEqual({ state: "not-configured" });
    expect(s.spy).not.toHaveBeenCalled();
  });

  it("turns a failed listing into a message without the token in it", async () => {
    const fetch = vi.fn(async () => {
      throw new Error(`connect failed for https://graph.facebook.com/v26.0/1234/message_templates?access_token=${TOKEN}`);
    }) as unknown as typeof globalThis.fetch;
    const r = await checkCloudTemplates({ fetch, env: ENV });
    expect(r.state).toBe("error");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("passes Meta's own error message through", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: "Invalid OAuth access token", code: 190 } }), { status: 401 }),
    ) as unknown as typeof globalThis.fetch;
    const r = await checkCloudTemplates({ fetch, env: ENV });
    expect(r).toEqual({ state: "error", message: expect.stringContaining("Invalid OAuth access token") });
  });
});

describe("submitCloudTemplates (Submit to Meta)", () => {
  it("posts the new template and reports it created", async () => {
    const s = stubFetch(ALL_BUT_ONE);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await submitCloudTemplates({ fetch: s.fetch, env: ENV });
    expect(s.methods.filter((m) => m === "POST").length).toBe(1);
    expect(r).toMatchObject({ state: "ok", applied: [{ name: "mt_pool_offer", language: "tr", action: "created" }], skipped: [], failed: [] });
    // The server log never carries the token.
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    log.mockRestore();
  });

  it("reports a refusal with Meta's error message", async () => {
    const s = stubFetch(ALL_BUT_ONE, { failPost: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await submitCloudTemplates({ fetch: s.fetch, env: ENV });
    expect(r).toMatchObject({
      state: "ok",
      applied: [],
      failed: [{ name: "mt_pool_offer", language: "tr", why: expect.stringContaining("Invalid parameter") }],
    });
    log.mockRestore();
  });

  it("submits nothing when not configured", async () => {
    const s = stubFetch([]);
    expect(await submitCloudTemplates({ fetch: s.fetch, env: {} })).toEqual({ state: "not-configured" });
    expect(s.spy).not.toHaveBeenCalled();
  });

  it("never takes the real fetch inside a test run, even with a made-up env", async () => {
    // The process is a test run; the env handed in does not say so. Without
    // the module's own check this would reach Meta.
    const real = globalThis.fetch;
    const spy = vi.fn(async () => new Response("{}", { status: 500 }));
    globalThis.fetch = spy as unknown as typeof globalThis.fetch;
    try {
      expect(await submitCloudTemplates({ fetch: globalThis.fetch, env: ENV })).toEqual({ state: "error", message: expect.stringMatching(/real fetch/) });
      expect(await checkCloudTemplates({ fetch: globalThis.fetch, env: ENV })).toEqual({ state: "error", message: expect.stringMatching(/real fetch/) });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = real;
    }
  });
});
