/**
 * A shared /play link's preview words (2026-11-03) keep the house rules in
 * both languages, and stay player-facing: no price, nothing for organisers.
 */
import { describe, expect, it } from "vitest";
import { poolLinkPreviewCopy } from "../pool-link-preview";
import { POOL_LINK_PREVIEW_EN } from "../pool-link-preview.en";
import { POOL_LINK_PREVIEW_TR } from "../pool-link-preview.tr";

const lines = (c: typeof POOL_LINK_PREVIEW_EN) => [c.title, c.description, c.imageAlt, c.imageBadge, ...c.imageSteps];
const ALL = [...lines(POOL_LINK_PREVIEW_EN), ...lines(POOL_LINK_PREVIEW_TR)];

describe("link preview copy", () => {
  it("no em or en dash, no slash, never a waiting list, never empty", () => {
    expect(ALL.filter((l) => /[—–\/]/.test(l))).toEqual([]);
    expect(ALL.filter((l) => /waiting list|bekleme listesi/i.test(l))).toEqual([]);
    expect(ALL.filter((l) => !l.trim())).toEqual([]);
  });
  it("Turkish is translated, line by line", () => {
    const en = lines(POOL_LINK_PREVIEW_EN);
    lines(POOL_LINK_PREVIEW_TR).forEach((l, i) => expect(l).not.toBe(en[i]));
  });
  it("no price and nothing for organisers", () => {
    expect(ALL.filter((l) => /£|\bfee|price|\bpay\b|bench|partner club|autopilot|organis|ücret[^s]|yedek/i.test(l))).toEqual([]);
  });
  it("short enough for a preview card: the title under 60 characters, the description under 200", () => {
    for (const c of [POOL_LINK_PREVIEW_EN, POOL_LINK_PREVIEW_TR]) {
      expect(c.title.length).toBeLessThanOrEqual(60);
      expect(c.description.length).toBeLessThanOrEqual(200);
    }
  });
  it("anything unknown is English", () => {
    expect(poolLinkPreviewCopy("de")).toBe(POOL_LINK_PREVIEW_EN);
    expect(poolLinkPreviewCopy("tr")).toBe(POOL_LINK_PREVIEW_TR);
  });
});
