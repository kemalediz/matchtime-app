/**
 * PRIVACY GUARD for the owner's pool funnel (growth slice G2): counts only.
 * The loader, the rules, the page and its CSV route must never read a
 * person's name, number, email, area, distance, referrer or share code.
 * Pinned on the source, so a later "just add the names" fails here; the
 * Playwright spec checks the rendered page and the CSV.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..", "..");
const files = (dir: string): string[] =>
  readdirSync(path.join(SRC, dir)).flatMap((n) => {
    const rel = `${dir}/${n}`;
    if (n === "__tests__") return [];
    return statSync(path.join(SRC, rel)).isDirectory() ? files(rel) : /\.tsx?$/.test(n) ? [rel] : [];
  });
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

const SURFACE = ["lib/pool/funnel-rules.ts", "lib/pool/funnel-loader.ts", ...files("app/admin/pool/funnel")];

describe("the pool funnel never reads who someone is", () => {
  it("covers the page, the chart and the CSV route", () => {
    expect(SURFACE).toEqual(expect.arrayContaining(["app/admin/pool/funnel/page.tsx", "app/admin/pool/funnel/funnel.csv/route.ts"]));
  });

  it("no name, number, email, area, distance, referrer or share code anywhere in it", () => {
    const re = /\b(name: true|displayName|phone|phoneNumber|email|areaDistrict|areaLat|areaLng|maxMiles|distanceMiles|referrerUserId|shareCode|claimPhone|signupIp)\b/;
    expect(SURFACE.filter((f) => re.test(read(f)))).toEqual([]);
  });

  it("the profile is read for its funnel facts only", () => {
    expect(read("lib/pool/funnel-loader.ts")).toContain(
      "select: { userId: true, createdAt: true, status: true, consentAt: true, town: true, source: true, sourceCode: true, earlyList: true, sports: { select: { sport: true } } }",
    );
  });

  it("a source code is shown only for a campaign sign-up (a referral's is a person's code)", () => {
    expect(read("lib/pool/funnel-rules.ts")).toContain('const campaignCodeOf = (p: FunnelProfileFact): string | null => (sourceOf(p) === "campaign" ? p.sourceCode : null);');
  });
});
