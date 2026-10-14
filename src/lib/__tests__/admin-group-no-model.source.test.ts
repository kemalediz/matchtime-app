/**
 * Slice 2a (plan 2.5, D13): a message in an admin group never reached a
 * model. Since 2026-10-14 ONE door does: an owner's or admin's squad change
 * ("Shehryar out") goes through the same router and attendance engine as
 * the players' group, in `admin-group-squad-change.ts`, and nowhere else.
 *
 * This pins that:
 *   - the link-command route still reaches no model at all;
 *   - the admin-group route reaches one ONLY through that module: with it
 *     cut out of the graph, nothing reachable can call a model (the pick
 *     replies, PAID, the pasted list and its YES are deterministic). One
 *     more file is cut: `attendance.ts`, the shared writer every path in
 *     the product uses, which the pasted list's YES applies through. It
 *     reaches the SDK statically (attendance -> bot-scheduler ->
 *     message-analyzer) and has always done so for every caller; that
 *     chain is pinned below so a new one cannot hide behind it;
 *   - that module is imported by `admin-group.ts` and by nothing else on
 *     the path, so the admin and club checks in front of it are the only
 *     way in (and `admin-group.test.ts` pins that a non-admin never gets
 *     there).
 *
 * Reads the sources, the same way `admin-nudge-links.source.test.ts` does,
 * and follows every relative `@/lib` import transitively.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const SQUAD_CHANGE = "src/lib/admin-group-squad-change.ts";
const WRITER = "src/lib/attendance.ts";

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) if (existsSync(cand)) return cand;
  return null;
}

/** Every source file reachable from `entry`, and every bare package it
 *  imports, never following into `stop`. `importers` maps a file to the
 *  files that import it. */
function importGraph(entry: string, stop: string[] = []) {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const importers = new Map<string, Set<string>>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)) {
      const next = resolveImport(f, m[1]);
      if (next) {
        const rel = path.relative(ROOT, next);
        importers.set(rel, (importers.get(rel) ?? new Set()).add(path.relative(ROOT, f)));
        if (!stop.includes(rel)) stack.push(next);
      } else if (!m[1].startsWith(".") && !m[1].startsWith("@/")) packages.add(m[1]);
    }
  }
  return { files: [...seen].map((f) => path.relative(ROOT, f)), packages: [...packages], importers };
}

const FORBIDDEN_FILES = /message-analyzer|\/pipeline\/|dm-intent|dm-qa|onboarding-analyzer|window-analyzer|payment-claim-classifier|roster-survey-classifier|match-availability-classifier|attendance-engine-batch/;

function expectModelFree(files: string[], packages: string[]) {
  expect(files.length).toBeGreaterThan(1);
  expect(packages.filter((p) => p.includes("anthropic"))).toEqual([]);
  expect(files.filter((f) => FORBIDDEN_FILES.test(f))).toEqual([]);
}

describe("admin-group paths and the model", () => {
  it("the link-command route never reaches a model", () => {
    const { files, packages } = importGraph(path.join(ROOT, "src/app/api/whatsapp/admin-group-link/route.ts"));
    expectModelFree(files, packages);
  });

  it("the admin-group route reaches one only through the squad-change module", () => {
    const { files, packages, importers } = importGraph(path.join(ROOT, "src/app/api/whatsapp/admin-group/route.ts"), [
      SQUAD_CHANGE,
      WRITER,
    ]);
    expectModelFree(files, packages);
    expect([...(importers.get(SQUAD_CHANGE) ?? [])]).toEqual(["src/lib/admin-group.ts"]);
    expect([...(importers.get(WRITER) ?? [])]).toEqual(["src/lib/admin-group-paste.ts"]);
  });

  it("the shared writer reaches the SDK only by the scheduler's old import", () => {
    const { files, packages } = importGraph(path.join(ROOT, WRITER), ["src/lib/bot-scheduler.ts"]);
    expectModelFree(files, packages);
  });

  it("and that module does reach the router and the attendance engine (it is the door)", () => {
    const { files } = importGraph(path.join(ROOT, SQUAD_CHANGE));
    expect(files).toContain("src/lib/pipeline/gate.ts");
    expect(files).toContain("src/lib/attendance-engine-batch.ts");
  });
});
