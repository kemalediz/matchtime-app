/**
 * The owner's WhatsApp templates page, rendered to HTML: the dry run's
 * difference (new, changed, same, not ours, with Meta's status and
 * category), the status rows Meta's webhooks wrote, and Submit's result
 * per template (created, edited, skipped, failed with Meta's words).
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SyncResultList, TemplateDiffTable, TemplateStatusTable } from "../template-sync-view";

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
}

const DIFFS = [
  { name: "mt_pool_offer", language: "tr", kind: "new" as const },
  { name: "mt_pool_paused", language: "en_GB", kind: "changed" as const, metaId: "1", metaStatus: "APPROVED", changes: ["body", "buttons"] },
  { name: "mt_pool_resumed", language: "en_GB", kind: "same" as const, metaId: "2", metaStatus: "APPROVED", metaCategory: "MARKETING" },
  { name: "mt_old_thing", language: "en_GB", kind: "not-ours" as const, metaId: "3", metaStatus: "PAUSED" },
];

describe("TemplateDiffTable", () => {
  it("shows each template's difference with Meta's status and category", () => {
    const html = renderToStaticMarkup(createElement(TemplateDiffTable, { diffs: DIFFS }));
    const out = text(html);
    expect(out).toContain("mt_pool_offer");
    expect(out).toMatch(/New/);
    expect(out).toMatch(/Changed: body, buttons/);
    expect(out).toMatch(/Same/);
    expect(out).toMatch(/Not ours/);
    expect(out).toContain("APPROVED");
    expect(out).toContain("PAUSED");
    expect(out).toContain("MARKETING");
    expect(html.match(/data-testid="wt-diff"/g)).toHaveLength(4);
    expect(html).not.toMatch(/[–—]/);
  });

  it("says so when Meta and the code agree on nothing yet", () => {
    expect(text(renderToStaticMarkup(createElement(TemplateDiffTable, { diffs: [] })))).toContain("No templates");
  });
});

describe("TemplateStatusTable", () => {
  it("lists each row with status, category, quality and reason", () => {
    const rows = [
      {
        name: "mt_pool_offer",
        language: "en_GB",
        status: "REJECTED",
        category: "UTILITY",
        previousCategory: null,
        qualityScore: "GREEN",
        reason: "INVALID_FORMAT",
        updatedAt: new Date("2026-11-06T10:00:00Z"),
      },
      {
        name: "mt_pool_paused",
        language: "tr",
        status: "APPROVED",
        category: "MARKETING",
        previousCategory: "UTILITY",
        qualityScore: null,
        reason: null,
        updatedAt: new Date("2026-11-06T11:00:00Z"),
      },
    ];
    const html = renderToStaticMarkup(createElement(TemplateStatusTable, { rows }));
    const out = text(html);
    expect(html.match(/data-testid="wt-status"/g)).toHaveLength(2);
    expect(out).toContain("REJECTED");
    expect(out).toContain("INVALID_FORMAT");
    expect(out).toContain("GREEN");
    expect(out).toMatch(/MARKETING \(was UTILITY\)/);
    expect(html).not.toMatch(/[–—]/);
  });

  it("says so when Meta has not reported anything yet", () => {
    expect(text(renderToStaticMarkup(createElement(TemplateStatusTable, { rows: [] })))).toContain("No status from Meta yet");
  });
});

describe("SyncResultList", () => {
  it("shows created, edited, skipped and failed, with Meta's error message", () => {
    const result = {
      state: "ok" as const,
      diffs: [],
      applied: [
        { name: "mt_pool_offer", language: "tr", action: "created" as const },
        { name: "mt_pool_paused", language: "en_GB", action: "edited" as const },
      ],
      skipped: [{ name: "mt_pool_resumed", language: "en_GB", why: "PENDING at Meta: edit it once reviewed" }],
      failed: [{ name: "mt_code", language: "tr", why: "HTTP 400 100: Invalid parameter" }],
    };
    const html = renderToStaticMarkup(createElement(SyncResultList, { result }));
    const out = text(html);
    expect(html.match(/data-testid="wt-result"/g)).toHaveLength(4);
    expect(out).toMatch(/mt_pool_offer tr: Created/);
    expect(out).toMatch(/mt_pool_paused en_GB: Edited/);
    expect(out).toMatch(/mt_pool_resumed en_GB: Skipped, PENDING at Meta: edit it once reviewed/);
    expect(out).toMatch(/mt_code tr: Failed, HTTP 400 100: Invalid parameter/);
    expect(html).not.toMatch(/[–—]/);
  });

  it("shows a refusal, a missing setting and an error in words", () => {
    expect(text(renderToStaticMarkup(createElement(SyncResultList, { result: { state: "forbidden" } })))).toContain("Only the platform owner");
    expect(text(renderToStaticMarkup(createElement(SyncResultList, { result: { state: "not-configured" } })))).toContain("WA_CLOUD_WABA_ID");
    expect(text(renderToStaticMarkup(createElement(SyncResultList, { result: { state: "error", message: "HTTP 401 190: Invalid OAuth access token" } })))).toContain(
      "Invalid OAuth access token",
    );
  });

  it("says when there was nothing to submit", () => {
    const result = { state: "ok" as const, diffs: [], applied: [], skipped: [], failed: [] };
    expect(text(renderToStaticMarkup(createElement(SyncResultList, { result })))).toContain("Nothing to submit");
  });
});
