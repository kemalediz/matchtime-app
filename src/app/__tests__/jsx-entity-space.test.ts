/**
 * THE MISSING SPACE AFTER A HIGHLIGHTED WORD (2026-11-16).
 *
 * The player guide read "MatchTime picks up IN and OUTon its own",
 * "shows as @Match Timein your message" and "turn on Play elsewhere tooon
 * your profile". No component trims anything: Next's own compiler does.
 * The SWC build bundled with Next (16.2.1) drops the LEADING whitespace of
 * a JSX text that spans more than one line AND contains an HTML entity
 * (`&apos;`, `&quot;`, `&#39;` ...), so the space between a closing tag and
 * the words after it disappears:
 *
 *   <code>OUT</code> on its own,          renders  "OUTon its own, yours
 *   yours or a teammate&apos;s.                     or a teammate's."
 *
 * Without the entity, or on one line, the space survives, which is why
 * only some sentences lost it. The entities are there because the lint
 * rule `react/no-unescaped-entities` asks for them. The fix is an explicit
 * `{" "}` where such a text starts with a space: an expression, so the
 * compiler cannot trim it.
 *
 *   1. pins the compiler's behaviour (if a Next upgrade fixes it, the first
 *      assertion fails and this guard can be retired);
 *   2. scans every .tsx under src/ so the shape cannot come back.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..");

/** A JSX text that starts with spaces, runs over more than one line and
 *  holds an entity: the compiler drops its leading space. */
function losesLeadingSpace(raw: string): boolean {
  return /&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/.test(raw) && raw.includes("\n") && /^[ \t]+\S/.test(raw);
}

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === "generated") continue;
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function offenders(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const visit = (n: ts.Node) => {
    if (n.kind === ts.SyntaxKind.JsxText && losesLeadingSpace(src.slice(n.pos, n.end))) {
      const line = sf.getLineAndCharacterOfPosition(n.pos).line + 1;
      hits.push(`${path.relative(SRC, file)}:${line}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

/** Next's own SWC, as the build runs it. */
async function compile(jsx: string): Promise<string> {
  const swc = await import("next/dist/build/swc/index.js");
  await swc.loadBindings();
  const out = await swc.transform(`export const A = () => (${jsx});`, {
    jsc: { parser: { syntax: "typescript", tsx: true }, transform: { react: { runtime: "automatic" } } },
    minify: true,
  });
  return out.code;
}

describe("Next's compiler and a space after a closing tag", () => {
  it("a multi-line text with an entity loses its leading space; an explicit {\" \"} keeps it", async () => {
    expect(await compile(`<p><code>OUT</code> on its own,\n  yours or a teammate&apos;s.</p>`)).toContain(`"on its own, yours or a teammate's."`);
    const fixed = await compile(`<p><code>OUT</code>{" "}on its own,\n  yours or a teammate&apos;s.</p>`);
    expect(fixed).toContain(`" ","on its own, yours or a teammate's."`);
    // The shapes that were always fine: no entity, or one line.
    expect(await compile(`<p><code>OUT</code> on its own,\n  yours.</p>`)).toContain(`" on its own, yours."`);
    expect(await compile(`<p><code>OUT</code> on it&apos;s own</p>`)).toContain(`" on it's own"`);
  }, 30_000);

  it("the detector agrees with the compiler", () => {
    expect(losesLeadingSpace(" on its own,\n  yours or a teammate&apos;s.")).toBe(true);
    expect(losesLeadingSpace(" say &quot;hi&quot;\n  there")).toBe(true);
    expect(losesLeadingSpace(" on its own,\n  yours.")).toBe(false);
    expect(losesLeadingSpace(" on it&apos;s own")).toBe(false);
    expect(losesLeadingSpace("\n  it&apos;s here ")).toBe(false);
  });
});

describe("no page loses a space after a highlighted word", () => {
  it("no JSX text under src/ starts with a space, runs over lines and holds an entity", () => {
    expect(tsxFiles(SRC).flatMap(offenders)).toEqual([]);
  });
});
