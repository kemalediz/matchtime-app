/**
 * Slice 2a (plan 2.5, D13): a message in an admin group never reaches a
 * model. The Pi forwards it to /api/whatsapp/admin-group and nowhere else;
 * this pins that the route, the module behind it, and the link-command
 * path import nothing that can call one. Reads the sources, the same way
 * `admin-nudge-links.source.test.ts` does, and follows every relative
 * `@/lib` import transitively.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) if (existsSync(cand)) return cand;
  return null;
}

/** Every source file reachable from `entry`, and every bare package it imports. */
function importGraph(entry: string): { files: string[]; packages: string[] } {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)) {
      const next = resolveImport(f, m[1]);
      if (next) stack.push(next);
      else if (!m[1].startsWith(".") && !m[1].startsWith("@/")) packages.add(m[1]);
    }
  }
  return { files: [...seen].map((f) => path.relative(ROOT, f)), packages: [...packages] };
}

const FORBIDDEN_FILES = /message-analyzer|\/pipeline\/|dm-intent|dm-qa|onboarding-analyzer|window-analyzer|payment-claim-classifier|roster-survey-classifier|match-availability-classifier/;

describe("admin-group paths never reach a model", () => {
  for (const entry of ["src/app/api/whatsapp/admin-group/route.ts", "src/app/api/whatsapp/admin-group-link/route.ts"]) {
    it(entry, () => {
      const { files, packages } = importGraph(path.join(ROOT, entry));
      expect(files.length).toBeGreaterThan(1);
      expect(packages.filter((p) => p.includes("anthropic"))).toEqual([]);
      expect(files.filter((f) => FORBIDDEN_FILES.test(f))).toEqual([]);
    });
  }
});
