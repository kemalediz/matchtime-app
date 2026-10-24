/**
 * PRIVACY GUARD for the Guest players page (pool slice L5b; plan section 6,
 * approved spec: "Phone, area and other clubs hidden").
 *
 * The page, its CSV, the match page's guest card and the loader behind them
 * must never read a guest's phone number, email, area or travel distance,
 * and the only club they may name is the partner club a partner guest came
 * from. Pinned on the source, so a later "just add the phone" fails here
 * before it reaches a screen. The Playwright spec checks the rendered DOM.
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

const SURFACE = [
  "lib/pool/guest-report.ts",
  "lib/pool/guest-report-loader.ts",
  "lib/pool/club-invite.ts",
  ...files("app/admin/guests"),
  ...files("components/guests"),
];
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

describe("the Guest players surface never reads what it must not show", () => {
  it("covers the page, the CSV route and the card", () => {
    expect(SURFACE).toEqual(expect.arrayContaining(["app/admin/guests/page.tsx", "app/admin/guests/report.csv/route.ts", "components/guests/guest-card.tsx"]));
  });

  it("no phone, email, area, travel distance or town anywhere in it", () => {
    const re = /\b(phoneNumber|phone|email|areaDistrict|areaLat|areaLng|venueIds|maxMiles|town|homeOrgId)\b/;
    expect(SURFACE.filter((f) => re.test(read(f)))).toEqual([]);
  });

  it("the loader names a club only by the partner club ids a guest came from", () => {
    const src = read("lib/pool/guest-report-loader.ts");
    const lookups = [...src.matchAll(/db\.organisation\.(\w+)\(\s*\{\s*where:\s*\{([^}]*)\}/g)].map((m) => `${m[1]}:${m[2].trim()}`);
    expect(lookups.sort()).toEqual(["findMany:id: { in: fromOrgIds", "findUnique:id: orgId"]);
    expect(src).toMatch(/fromOrgIds = \[\.\.\.new Set\(\[\.\.\.guestMemberships\.map\(\(m\) => m\.guestFromOrgId\), \.\.\.placesHere\.map\(\(p\) => p\.fromOrgId\)\]/);
  });

  it("the pool profile is read for its status and sports only", () => {
    const src = read("lib/pool/guest-report-loader.ts");
    expect(src).toContain("select: { userId: true, status: true, sports: { select: { sport: true, otherName: true, level: true, levelText: true } } }");
    expect(src).toContain('db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })');
  });

  it("another club's game is read as a result only", () => {
    const src = read("lib/pool/guest-report-loader.ts");
    expect(src).toContain("db.guestPlace.findMany({ where: { userId: { in: userIds }, orgId: { not: orgId } }, select: { userId: true, matchId: true, result: true, settledAt: true } })");
    expect(src).toMatch(/sportName: here \? m\.activity\.sport\.name : ""/);
    expect(src).toMatch(/venue: here \? m\.activity\.venue : ""/);
  });
});
