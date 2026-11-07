/**
 * `scripts/cloud-templates.ts`'s engine (plan 5.6, PR C6): the registry
 * compared with Meta's `GET /<WABA_ID>/message_templates`, a dry run by
 * default, `--apply` only when passed exactly. Every test runs on a stubbed
 * fetch: nothing here ever reaches Meta.
 */
import { describe, expect, it, vi } from "vitest";
import { CLOUD_TEMPLATES, META_LANG, metaComponents } from "../templates";
import { diffTemplates, parseSyncArgs, syncTemplates, type MetaTemplate } from "../template-sync";

const ENV = { WA_CLOUD_WABA_ID: "1234", WA_CLOUD_ACCESS_TOKEN: "tok", WA_CLOUD_GRAPH_VERSION: "v26.0" };
const BASE = "https://graph.facebook.com/v26.0";
const TOTAL = CLOUD_TEMPLATES.length * 2;

/** What Meta would list for a registry template it already holds as is. */
function asMeta(name: string, lang: "en" | "tr", over: Partial<MetaTemplate> = {}): MetaTemplate {
  const t = CLOUD_TEMPLATES.find((x) => x.name === name)!;
  return { id: `id_${name}_${lang}`, name, language: META_LANG[lang], status: "APPROVED", category: t.category, components: metaComponents(t.name, lang), ...over };
}

type Call = { url: string; method: string; body: unknown; auth: string | null };

function stubFetch(pages: MetaTemplate[][], opts: { failPost?: boolean } = {}) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null, auth: headers.get("authorization") });
    if (method === "GET") {
      const page = Number(new URL(url).searchParams.get("after") ?? "0");
      const next = page + 1 < pages.length ? `${BASE}/1234/message_templates?limit=100&after=${page + 1}` : undefined;
      return new Response(JSON.stringify({ data: pages[page] ?? [], paging: next ? { next } : {} }), { status: 200 });
    }
    if (opts.failPost) return new Response(JSON.stringify({ error: { message: "Invalid parameter", code: 100 } }), { status: 400 });
    return new Response(JSON.stringify({ id: "new_id", status: "PENDING", category: "UTILITY" }), { status: 200 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe("parseSyncArgs", () => {
  it("is a dry run unless --apply is passed exactly", () => {
    expect(parseSyncArgs([])).toEqual({ apply: false });
    expect(parseSyncArgs(["--apply"])).toEqual({ apply: true });
    expect(() => parseSyncArgs(["--aply"])).toThrow(/unknown/i);
    expect(() => parseSyncArgs(["--apply=yes"])).toThrow(/unknown/i);
    expect(() => parseSyncArgs(["apply"])).toThrow(/unknown/i);
  });
});

describe("diffTemplates", () => {
  it("new, changed, same, Meta's other category, and Meta's own we do not hold", () => {
    const changedBody = asMeta("mt_pool_offer", "en", {
      components: [{ type: "BODY", text: "An older offer text with {{1}} in it." }, ...metaComponents("mt_pool_offer", "en").slice(1)],
    });
    const meta = [
      asMeta("mt_pool_paused", "en"),
      asMeta("mt_pool_paused", "tr", { category: "MARKETING" }),
      changedBody,
      asMeta("mt_code", "en", { components: [{ type: "BODY", text: "*{{1}}* is your verification code." }] }),
      { id: "x", name: "mt_old_thing", language: "en_GB", status: "APPROVED", category: "UTILITY", components: [] },
      { id: "y", name: "hello_world", language: "en_US", status: "APPROVED", category: "UTILITY", components: [] },
    ];
    const d = diffTemplates(meta);
    const of = (name: string, language: string) => d.find((x) => x.name === name && x.language === language);
    expect(of("mt_pool_paused", "en_GB")).toMatchObject({ kind: "same" });
    expect(of("mt_pool_paused", "tr")).toMatchObject({ kind: "same", metaCategory: "MARKETING" });
    expect(of("mt_pool_offer", "en_GB")).toMatchObject({ kind: "changed", metaId: "id_mt_pool_offer_en", changes: ["body"] });
    expect(of("mt_pool_offer", "tr")).toMatchObject({ kind: "new" });
    // Authentication text is Meta's own: present is enough.
    expect(of("mt_code", "en_GB")).toMatchObject({ kind: "same" });
    expect(of("mt_old_thing", "en_GB")).toMatchObject({ kind: "not-ours" });
    // Only our own mt_ names are reported; Meta's samples are not ours to judge.
    expect(of("hello_world", "en_US")).toBeUndefined();
  });

  it("a changed button is a change", () => {
    const comps = metaComponents("mt_pool_paused", "en");
    const buttons = { type: "BUTTONS", buttons: [{ type: "URL", text: "Settings", url: "https://matchtime.ai/play/manage/{{1}}" }] };
    const d = diffTemplates([asMeta("mt_pool_paused", "en", { components: [comps[0], buttons] })]);
    expect(d.find((x) => x.name === "mt_pool_paused" && x.language === "en_GB")).toMatchObject({ kind: "changed", changes: ["buttons"] });
  });
});

describe("syncTemplates", () => {
  it("refuses to run without the WABA id and token, before any request", async () => {
    const { fetch, calls } = stubFetch([[]]);
    await expect(syncTemplates({ fetch, env: {}, apply: false, log: () => {} })).rejects.toThrow(/WA_CLOUD_WABA_ID/);
    expect(calls).toEqual([]);
  });

  it("refuses the real fetch inside a test run", async () => {
    await expect(syncTemplates({ fetch: globalThis.fetch, env: { ...ENV, VITEST: "true" }, apply: false, log: () => {} })).rejects.toThrow(/stub/i);
  });

  it("a dry run reads every page and sends nothing", async () => {
    const { fetch, calls } = stubFetch([[asMeta("mt_pool_paused", "en")], [asMeta("mt_pool_paused", "tr")]]);
    const lines: string[] = [];
    const r = await syncTemplates({ fetch, env: ENV, apply: false, log: (l) => lines.push(l) });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`${BASE}/1234/message_templates?fields=id,name,language,status,category,components&limit=100`);
    expect(calls[0].auth).toBe("Bearer tok");
    expect(r.applied).toEqual([]);
    expect(r.diffs.filter((d) => d.kind === "new")).toHaveLength(TOTAL - 2);
    expect(lines.join("\n")).toMatch(/dry run/i);
    expect(lines.join("\n")).not.toContain("tok");
  });

  it("--apply creates the new, edits the changed, leaves the same and the pending alone, never deletes", async () => {
    const pendingChanged = asMeta("mt_pool_resumed", "en", { status: "PENDING", components: [{ type: "BODY", text: "old" }] });
    const changed = asMeta("mt_pool_paused", "en", { components: [{ type: "BODY", text: "old {{1}} text" }] });
    const { fetch, calls } = stubFetch([[asMeta("mt_pool_paused", "tr"), changed, pendingChanged, { id: "z", name: "mt_gone", language: "en_GB", status: "APPROVED", category: "UTILITY", components: [] }]]);
    const r = await syncTemplates({ fetch, env: ENV, apply: true, log: () => {} });
    const posts = calls.filter((c) => c.method === "POST");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    // One create per new (name, language), one edit for the changed one.
    expect(posts).toHaveLength(TOTAL - 3 + 1);
    const edit = posts.find((p) => p.url === `${BASE}/id_mt_pool_paused_en`);
    expect(edit?.body).toEqual({ components: metaComponents("mt_pool_paused", "en") });
    const create = posts.find((p) => p.url === `${BASE}/1234/message_templates` && (p.body as { name: string; language: string }).name === "mt_code" && (p.body as { language: string }).language === "tr");
    expect(create?.body).toEqual({ name: "mt_code", language: "tr", category: "AUTHENTICATION", components: metaComponents("mt_code", "tr") });
    expect(posts.some((p) => p.url.endsWith("/id_mt_pool_resumed_en"))).toBe(false);
    expect(r.skipped).toEqual([{ name: "mt_pool_resumed", language: "en_GB", why: "PENDING at Meta: edit it once reviewed" }]);
    expect(r.failed).toEqual([]);
  });

  it("a refused submission is reported and the rest go on", async () => {
    const { fetch, calls } = stubFetch([[]], { failPost: true });
    const r = await syncTemplates({ fetch, env: ENV, apply: true, log: () => {} });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(TOTAL);
    expect(r.failed).toHaveLength(TOTAL);
    expect(r.failed[0].why).toContain("Invalid parameter");
  });
});
