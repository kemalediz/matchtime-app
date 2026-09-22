/**
 * ══════════════════════════════════════════════════════════════════════
 * ONLY THE DRIVERS KNOW WHICH WHATSAPP LIBRARY IS UNDERNEATH.
 * ══════════════════════════════════════════════════════════════════════
 *
 * `MDs/baileys-migration-plan-2026-09-21.md` Phase 2. The whole value of
 * the seam is that swapping whatsapp-web.js for Baileys is one env var and
 * the rollback is one revert. That is only true while the rest of the bot
 * genuinely cannot see the library: one surviving `client.sendMessage` in
 * `scheduler.ts` and the swap stops being a decision and becomes a
 * migration again.
 *
 * A grep does not stay done, so this file is the grep. It scans SOURCE
 * text rather than importing anything, because importing `index.ts` would
 * build a WhatsApp client, and no test in this repo may open a socket
 * (`src/baileys/main.source.test.ts` has the incident that rule comes
 * from).
 *
 * ── What is allowed where ────────────────────────────────────────────
 *   src/drivers/**   the whatsapp-web.js implementation. Everything.
 *   src/baileys/**   Phase 1's watch-only socket. Its own rules live in
 *                    `baileys/main.source.test.ts`.
 *   everything else  no library import, no `client.`, no `pupPage`.
 *
 * Comments AND string literals are stripped before the identifier checks,
 * or `degraded.ts`'s "Cause: whatsapp-web.js's injected page code…" and
 * `react-with-id.ts`'s "client.getMessageById threw inside the page" would
 * fail a rule they are only DESCRIBING. The stripper is itself tested
 * below, because a stripper that quietly removes everything is a guard
 * that quietly passes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.dirname(fileURLToPath(import.meta.url));

/** Directories that own a WhatsApp library, relative to `src/`. */
const DRIVER_DIRS = ["drivers", "baileys"];

function listSources(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const relPath = rel ? `${rel}/${entry}` : entry;
    if (statSync(abs).isDirectory()) {
      out.push(...listSources(abs, relPath));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    out.push(relPath);
  }
  return out;
}

/** Every non-test module under `src/` that is NOT part of a driver. */
const SEAM_FILES = listSources(SRC).filter(
  (f) => !DRIVER_DIRS.some((d) => f === d || f.startsWith(`${d}/`)),
);

/**
 * Remove comments and string literals, leaving code.
 *
 * Deliberately simple-minded: it walks the text once and tracks which of
 * the five contexts it is in. It does not understand regex literals, and
 * it does not need to. A `/.../` containing the word `client.` is not a
 * thing this codebase writes, and a false FAILURE is the safe direction
 * for a guard anyway.
 */
export function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  let mode: Mode = "code";
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (mode === "code") {
      if (c === "/" && next === "/") {
        mode = "line";
        i += 2;
      } else if (c === "/" && next === "*") {
        mode = "block";
        i += 2;
      } else if (c === "'") {
        mode = "single";
        i += 1;
      } else if (c === '"') {
        mode = "double";
        i += 1;
      } else if (c === "`") {
        mode = "template";
        i += 1;
      } else {
        out += c;
        i += 1;
      }
      continue;
    }
    if (mode === "line") {
      if (c === "\n") {
        out += "\n";
        mode = "code";
      }
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && next === "/") {
        mode = "code";
        i += 2;
      } else {
        if (c === "\n") out += "\n";
        i += 1;
      }
      continue;
    }
    // A string of some kind.
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (
      (mode === "single" && c === "'") ||
      (mode === "double" && c === '"') ||
      (mode === "template" && c === "`")
    ) {
      mode = "code";
      i += 1;
      continue;
    }
    if (c === "\n") out += "\n";
    i += 1;
  }
  return out;
}

function codeOf(relPath: string): string {
  return stripCommentsAndStrings(readFileSync(path.join(SRC, relPath), "utf8"));
}

/**
 * Comments stripped, string literals KEPT.
 *
 * An import specifier IS a string literal, so the import rules have to
 * read the text with strings intact or they pass vacuously. Caught by
 * writing the rule first and watching it go green against a tree that was
 * still importing the library everywhere.
 */
function importsOf(relPath: string): string {
  const src = readFileSync(path.join(SRC, relPath), "utf8");
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("the stripper the rules below depend on", () => {
  it("removes comments and string bodies but keeps the code around them", () => {
    const stripped = stripCommentsAndStrings(
      [
        "// client.getChats()",
        "/* client.sendMessage */",
        'const a = "client.getContactById threw";',
        "const b = `see client.info`;",
        "driver.sendText(chatId, text);",
      ].join("\n"),
    );
    expect(stripped).not.toMatch(/client\./);
    expect(stripped).toContain("driver.sendText");
    expect(stripped).toContain("const a =");
  });

  it("does not eat code after an escaped quote inside a string", () => {
    const stripped = stripCommentsAndStrings('const q = "a\\"b"; driver.close();');
    expect(stripped).toContain("driver.close()");
  });
});

describe("the library is imported in exactly one place", () => {
  it("finds the modules to scan at all", () => {
    // A listing bug would turn every rule below into a vacuous pass.
    expect(SEAM_FILES).toContain("index.ts");
    expect(SEAM_FILES).toContain("scheduler.ts");
    expect(SEAM_FILES).toContain("smart-analysis.ts");
    expect(SEAM_FILES.length).toBeGreaterThan(15);
  });

  /**
   * Static, dynamic and CommonJS. `smart-analysis.ts` reached the library
   * through `await import("whatsapp-web.js")` to build a bare Chat handle,
   * so a `from "…"` check alone would have missed the sharpest one.
   *
   * Matched as an IMPORT rather than as the bare module name, because both
   * names appear in ordinary prose that has to survive: `degraded.ts` and
   * `smart-analysis.ts` name whatsapp-web.js in the CRITICAL lines an
   * operator reads, and `driver-select.ts` names baileys in the error it
   * throws for `WA_DRIVER=baileys`.
   */
  const importsModule = (module: string) =>
    new RegExp(
      `(from|import|require)\\s*\\(?\\s*["']${module.replace(/\./g, "\\.")}["']`,
    );

  it("no module outside src/drivers and src/baileys imports whatsapp-web.js", () => {
    const rule = importsModule("whatsapp-web.js");
    const offenders = SEAM_FILES.filter((f) => rule.test(importsOf(f)));
    expect(offenders).toEqual([]);
  });

  it("no module outside src/drivers and src/baileys imports baileys", () => {
    const rule = importsModule("baileys");
    const offenders = SEAM_FILES.filter((f) => rule.test(importsOf(f)));
    expect(offenders).toEqual([]);
  });

  it("the import rule catches all three import forms", () => {
    // A guard that cannot see `await import("whatsapp-web.js")` would have
    // passed over the one call this refactor most needed to move.
    const rule = importsModule("whatsapp-web.js");
    expect(rule.test('import pkg from "whatsapp-web.js";')).toBe(true);
    expect(rule.test('const w = await import("whatsapp-web.js");')).toBe(true);
    expect(rule.test('const w = require("whatsapp-web.js");')).toBe(true);
    expect(rule.test('"upgrade whatsapp-web.js and redeploy"')).toBe(false);
  });
});

describe("nothing above the seam touches a client", () => {
  it("no module outside the drivers calls a method on a `client`", () => {
    // `client.` is the shape every one of the 2026-08/09 outage reports
    // quotes: client.getChats, client.getChatById, client.getContactById,
    // client.sendMessage, client.info.
    const offenders = SEAM_FILES.filter((f) => /\bclient\s*\.\s*[A-Za-z_$]/.test(codeOf(f)));
    expect(offenders).toEqual([]);
  });

  it("no module outside the drivers reaches for the puppeteer page", () => {
    const offenders = SEAM_FILES.filter((f) => /\bpupPage\b/.test(codeOf(f)));
    expect(offenders).toEqual([]);
  });

  it("no module outside the drivers constructs a WhatsApp client", () => {
    const offenders = SEAM_FILES.filter((f) => /new\s+Client\s*\(|makeWASocket\s*\(/.test(codeOf(f)));
    expect(offenders).toEqual([]);
  });
});

describe("the three modules Phase 2 names go through the driver", () => {
  for (const file of ["index.ts", "scheduler.ts", "smart-analysis.ts"]) {
    it(`${file} names a driver rather than a client`, () => {
      const code = codeOf(file);
      expect(code).toMatch(/\bdriver\b/);
      expect(code).not.toMatch(/\bclient\s*\.\s*[A-Za-z_$]/);
    });
  }
});
