/**
 * ONE SWITCH FOR ASKING PARTNER CLUBS (Kemal, 2026-11-08): "If it is
 * enabled for a club, it is enabled for all, no automatic calling or
 * anything. It is either on or off."
 *
 * An ACTIVE pairing (`ClubPartnership`) is the switch: its organisers may
 * ask that partner, and the player pool, whenever they like. There is no
 * club setting for when to ask (`partnerAskWhen`, `partnerAskTime`), no
 * automatic pool ask (`poolAutoAsk`), and nothing asks by itself (the
 * match-day sweep `sweepAutoPartnerAsks` and `pool/auto-ask.ts` are gone).
 *
 * This guard keeps them gone: no source file under src/ or scripts/ names
 * them, the Prisma model no longer has them (so the generated client never
 * selects the columns, and the reviewed drop file can follow the deploy),
 * and no copy, EN or TR, offers an automatic ask.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../i18n/strings.en";
import { tr } from "../i18n/strings.tr";

const SRC = path.resolve(__dirname, "..", "..");
const REPO = path.resolve(SRC, "..");
const rel = (f: string) => path.relative(REPO, f);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "generated" || name === "node_modules" || name === "__tests__") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const GONE = /\b(partnerAskWhen|partnerAskTime|poolAutoAsk|sweepAutoPartnerAsks|autoAskPool|poolWaitsForPartners|POOL_WAITS_FOR_PARTNERS_VIA|savePartnerAskSettingsAction|PartnerAskWhen|PARTNER_ASK_TIME_DEFAULT)\b/;

describe("asking partner clubs: an active pairing is the only switch", () => {
  const files = [...walk(SRC), ...walk(path.join(REPO, "scripts"))];

  it("no source file names the removed settings, the automatic ask or its pool wait", () => {
    const offenders = files.filter((f) => GONE.test(readFileSync(f, "utf8"))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("the matcher is not vacuous", () => {
    expect(GONE.test(`select: { partnerAskWhen: true }`)).toBe(true);
    expect(GONE.test(`await sweepAutoPartnerAsks(org.id)`)).toBe(true);
    expect(GONE.test(`partnerAskCutoffHours: 2`)).toBe(false);
  });

  it("the automatic ask's files are deleted", () => {
    for (const f of [
      "src/lib/pool/auto-ask.ts",
      "src/lib/pool/auto-ask-rules.ts",
      "src/app/actions/pool-auto-ask.ts",
      "src/components/settings/pool-auto-ask-section.tsx",
    ]) {
      expect(existsSync(path.join(REPO, f)), f).toBe(false);
    }
  });

  it("the due-posts poll no longer runs an automatic ask", () => {
    const route = readFileSync(path.join(SRC, "app/api/whatsapp/due-posts/route.ts"), "utf8");
    expect(route).not.toMatch(/AutoPartnerAsk|autoAsk/i);
    expect(route).toMatch(/sweepPartnerAsks/);
  });

  it("the Prisma model no longer has the three fields; the cut-off stays", () => {
    const schema = readFileSync(path.join(REPO, "prisma/schema.prisma"), "utf8");
    expect(schema).not.toMatch(/^\s*(partnerAskWhen|partnerAskTime|poolAutoAsk)\s+\w/m);
    expect(schema).toMatch(/^\s*partnerAskCutoffHours\s+Int\s+@default\(2\)/m);
  });

  it("the e2e CHECK file no longer names the dropped columns (db push drops them there)", () => {
    const sql = readFileSync(path.join(REPO, "prisma/sql/partner-ask-check.sql"), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/partnerAskWhen|partnerAskTime/);
    expect(sql).toMatch(/partnerAskCutoffHours/);
  });

  it("the drop file is separate, reviewed, and drops exactly the three columns", () => {
    const dir = readdirSync(path.join(REPO, "prisma/migrations")).filter((d) => d.endsWith("_drop_partner_ask_settings"));
    expect(dir).toHaveLength(1);
    const sql = readFileSync(path.join(REPO, "prisma/migrations", dir[0], "migration.sql"), "utf8");
    const code = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    for (const c of ["partnerAskWhen", "partnerAskTime", "poolAutoAsk"]) expect(code).toContain(`DROP COLUMN IF EXISTS "${c}"`);
    expect(code).not.toMatch(/partnerAskCutoffHours/);
    expect(sql).toMatch(/AFTER the deploy/i);
  });
});

describe("no copy offers an automatic ask, EN and TR", () => {
  const AUTO_EN = /by itself on match day|ask(?:s)? (?:the pool )?by itself|automatic ask|ask the player pool automatically|Automatically at a time/i;
  const AUTO_TR = /kendiliğinden sor|maç günü kendiliğinden|Belirli bir saatte kendiliğinden|otomatik sorma/i;

  it("the strings no longer carry the removed keys", () => {
    for (const k of ["pc_when_label", "pc_when_off", "pc_when_on_request", "pc_when_auto", "pc_time_label", "xask_refused_off", "xaskw_off", "xaskw_line_off", "xask_auto_notice_asker", "pauto_title", "pauto_blurb", "pauto_saved"]) {
      expect(k in en, k).toBe(false);
      expect(k in tr, k).toBe(false);
    }
  });

  it("help partners: once paired, an organiser asks partner clubs and the pool, on WhatsApp or the match page", () => {
    for (const s of [en, tr]) {
      const admin = s.onbHelpPartners({ audience: "admin", active: 2, url: "URL" });
      expect(admin).toContain("URL");
      expect(admin).not.toMatch(AUTO_EN);
      expect(admin).not.toMatch(AUTO_TR);
    }
    const a = en.onbHelpPartners({ audience: "admin", active: 2, url: "URL" });
    expect(a).toMatch(/partner clubs and the player pool/);
    expect(a).toMatch(/together or separately/);
    expect(a).toMatch(/WhatsApp or (?:on )?the match page/);
    const t = tr.onbHelpPartners({ audience: "admin", active: 2, url: "URL" });
    expect(t).toMatch(/birlikte ya da ayrı ayrı/);
    expect(t).toMatch(/WhatsApp/);
    expect(t).toMatch(/maç sayfası/);
    // No partner yet: still points at the settings page to find one.
    expect(en.onbHelpPartners({ audience: "admin", active: 0, url: "URL" })).toMatch(/no partner clubs yet/);
  });

  it("help pool: an organiser asks; nothing to switch on for automatic asking", () => {
    for (const s of [en, tr]) {
      const on = s.onbHelpPool({ audience: "admin", platformOpen: true, clubFlag: true, open: true, url: "URL", poolLabel: "POOL" });
      expect(on).not.toMatch(AUTO_EN);
      expect(on).not.toMatch(AUTO_TR);
      expect(on).toContain("POOL");
    }
    expect(en.onbHelpPool({ audience: "admin", platformOpen: true, clubFlag: true, open: true, url: "URL", poolLabel: "POOL" })).toMatch(/together or separately/);
  });
});
