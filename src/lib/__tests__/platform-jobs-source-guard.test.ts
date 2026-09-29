/**
 * SOURCE GUARDS for the platform channel (self-join slice 3).
 *
 * 1. `queueOwnerDm` is the doorbell, not the drawer. Kemal (2026-09-28):
 *    DMs to him only for things he must act on; routine alerts belong on
 *    the owner dashboard through `src/lib/ops-alerts.ts`. A helper that
 *    reaches his phone is exactly what a hurried health check would grab,
 *    so importing `owner-dm` is an ALLOWLIST: adding a caller means editing
 *    this file, on purpose, in review. Today nothing imports it; slices 6
 *    and 7 add the approval flow's callers.
 *
 * 2. `PlatformJob` rows are written only by `platform-jobs.ts` and
 *    `owner-dm.ts`, so the recipient rules in those two files cannot be
 *    walked around with a bare `db.platformJob.create`.
 *
 * 3. Sign-up and claim codes never borrow a club again. The old code picked
 *    "the first bot-enabled org" as a sender, so muting Sutton FC silently
 *    stopped every sign-up (plan 3.3).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..");
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "generated" || name === "node_modules" || name === "__tests__") continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const FILES = walk(SRC);
const code = (f: string) => stripComments(readFileSync(f, "utf8"));

/** Files allowed to import owner-dm. Extend deliberately, never for an alert. */
const OWNER_DM_IMPORTERS = new Set<string>([
  // slice 6: the one approval DM when a group is linked
  "app/api/whatsapp/bot-added/route.ts",
  // slice 7: the decision (APPROVE / REJECT) and its ack
  "lib/club-approval.ts",
  "app/api/whatsapp/dm-reply/route.ts",
]);

const OWNER_DM_IMPORT = /from\s+["'](?:@\/lib\/owner-dm|\.{1,2}\/(?:[\w-]+\/)*owner-dm)["']|import\(\s*["'][^"']*owner-dm["']\s*\)/;

describe("queueOwnerDm cannot become an alert channel", () => {
  it("is imported only by the approval flow's allowlisted files", () => {
    const importers = FILES.filter((f) => OWNER_DM_IMPORT.test(code(f))).map(rel);
    const outside = importers.filter((f) => !OWNER_DM_IMPORTERS.has(f));
    expect(outside).toEqual([]);
  });

  it("is never imported by ops-alerts, health or any cron", () => {
    const forbidden = FILES.filter((f) => {
      const r = rel(f);
      return r === "lib/ops-alerts.ts" || r === "lib/bot-health.ts" || r.startsWith("app/api/cron/");
    });
    expect(forbidden.length).toBeGreaterThan(3);
    for (const f of forbidden) expect(OWNER_DM_IMPORT.test(code(f)), rel(f)).toBe(false);
  });

  it("the import matcher is not vacuous", () => {
    expect(OWNER_DM_IMPORT.test(`import { queueOwnerDm } from "@/lib/owner-dm";`)).toBe(true);
    expect(OWNER_DM_IMPORT.test(`import { queueOwnerDm } from "./owner-dm";`)).toBe(true);
    expect(OWNER_DM_IMPORT.test(`const m = await import("@/lib/owner-dm");`)).toBe(true);
    expect(OWNER_DM_IMPORT.test(`import { x } from "@/lib/ops-alerts";`)).toBe(false);
  });
});

describe("PlatformJob has two writers", () => {
  const WRITERS = new Set(["lib/platform-jobs.ts", "lib/owner-dm.ts"]);

  it("nothing else creates a PlatformJob row", () => {
    const offenders = FILES.filter((f) => /platformJob\s*\.\s*(create|createMany|upsert)\s*\(/.test(code(f)))
      .map(rel)
      .filter((f) => !WRITERS.has(f));
    expect(offenders).toEqual([]);
  });

  it("the scan sees the writers (so the test is not vacuous)", () => {
    const writers = FILES.filter((f) => /platformJob\s*\.\s*create\s*\(/.test(code(f))).map(rel);
    expect(writers.sort()).toEqual([...WRITERS].sort());
  });
});

describe("verification codes never borrow a club", () => {
  for (const file of ["app/actions/phone-signup.ts", "app/actions/claim.ts"]) {
    it(`${file} does not pick a bot-enabled org as a sender`, () => {
      const src = code(path.join(SRC, file));
      expect(src).not.toMatch(/whatsappBotEnabled/);
      expect(src).not.toMatch(/botJob\s*\.\s*create/);
      expect(src).toMatch(/queuePlatformDm\(/);
    });
  }
});

describe('"use server" modules export async functions only', () => {
  // Found by the e2e suite on this slice: exporting the sign-up caps as
  // constants from phone-signup.ts made Next refuse the module, which broke
  // /signup and every page built after it. The caps live in
  // lib/signup-caps.ts for that reason.
  const serverModules = FILES.filter((f) => /^\s*["']use server["']/.test(readFileSync(f, "utf8")));

  it("finds the server action modules (so the test is not vacuous)", () => {
    expect(serverModules.map(rel)).toContain("app/actions/phone-signup.ts");
  });

  it("none exports a constant, a class or a re-export list", () => {
    const offenders: string[] = [];
    for (const f of serverModules) {
      code(f)
        .split("\n")
        .forEach((line, i) => {
          if (/^export\s+(const|let|var|class|enum|\{|\*)/.test(line) || /^export\s+(?!async\s+function|type\b|interface\b|default\s+async)/.test(line)) {
            offenders.push(`${rel(f)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
