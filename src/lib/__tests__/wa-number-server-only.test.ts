/**
 * THE MATCHTIME NUMBER IS SERVER-ONLY (plan section 5.2, Kemal's hard
 * rule for slice 4).
 *
 * The WhatsApp number MatchTime runs on must never be in a public page,
 * a public API response, a JS bundle or the sitemap. It is rendered only
 * inside the signed-in organiser's own club page, after the club exists.
 * The Playwright spec `e2e/web/self-join-organiser.spec.ts` proves the
 * rendered half against a running server; this file proves the source
 * half, so a later change cannot quietly widen the door:
 *
 *   1. exactly one source file reads `MATCHTIME_WA_NUMBER`
 *      (src/lib/club-connect.ts);
 *   2. nothing anywhere names a `NEXT_PUBLIC_` variant of it (Next inlines
 *      those into every client bundle);
 *   3. no client component ("use client") imports lib/club-connect.ts,
 *      so the reader can never be bundled for the browser (importing
 *      the server ACTION in app/actions/club-connect.ts is fine: Next
 *      sends the browser a reference to it, never its code);
 *   4. next.config does not forward it through `env` either;
 *   5. (local player pool, slice L2) the /play sign-up route is the ONE
 *      public API answer that carries it, in a wa.me link, only after a
 *      valid, rate-limited sign-up: a stranger must be able to write to
 *      MatchTime, since that message IS the pool's sign-up. Never the
 *      /play page or a bundle (e2e/web/play-signup.spec.ts checks the
 *      rendered page).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SRC = path.join(ROOT, "src");

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

const FILES = walk(SRC);
const READER = path.join(SRC, "lib", "club-connect.ts");

describe("MATCHTIME_WA_NUMBER stays on the server", () => {
  it("exactly one source file reads it: src/lib/club-connect.ts", () => {
    const readers = FILES.filter((f) => readFileSync(f, "utf8").includes("MATCHTIME_WA_NUMBER"));
    expect(readers.map((f) => path.relative(SRC, f))).toEqual([path.relative(SRC, READER)]);
  });

  it("no NEXT_PUBLIC_ variant exists anywhere in src or the Next config", () => {
    const offenders = [...FILES, path.join(ROOT, "next.config.ts")].filter((f) =>
      /NEXT_PUBLIC_[A-Z_]*WA_NUMBER|NEXT_PUBLIC_MATCHTIME_(WA|PHONE|NUMBER)/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("no client component imports the reader", () => {
    const offenders = FILES.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /^\s*["']use client["']/.test(src) && /from\s+["'](?:@\/lib\/|\.{1,2}\/(?:[^"']*\/)?)club-connect["']/.test(src);
    });
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it("next.config does not forward it to the browser", () => {
    expect(readFileSync(path.join(ROOT, "next.config.ts"), "utf8")).not.toContain("MATCHTIME_WA_NUMBER");
  });
});

describe("the /play sign-up is the one public API answer that carries the number (slice L2)", () => {
  const callers = FILES.filter((f) => f !== READER && /\bmatchtimeWaNumber\s*\(/.test(readFileSync(f, "utf8"))).map((f) => path.relative(SRC, f));
  it("no other API route calls matchtimeWaNumber", () => {
    expect(callers.filter((r) => r.startsWith("app/api/"))).toEqual(["app/api/play/signup/route.ts"]);
  });
  it("the pool's pages and components never do (the page renders no number)", () => {
    expect(callers.filter((r) => r.startsWith("app/play/") || r.startsWith("components/pool/"))).toEqual([]);
  });
});

describe("the official number (WA_CLOUD_NUMBER) follows the same rule (Cloud API plan, PR C1)", () => {
  // The Cloud API number is MatchTime's too (plan section 5.1): read in the
  // same server only file, never through NEXT_PUBLIC_, never forwarded.
  it("exactly one source file reads it: src/lib/club-connect.ts", () => {
    const readers = FILES.filter((f) => readFileSync(f, "utf8").includes("WA_CLOUD_NUMBER"));
    expect(readers.map((f) => path.relative(SRC, f))).toEqual([path.relative(SRC, READER)]);
  });

  it("no NEXT_PUBLIC_ variant exists anywhere in src or the Next config", () => {
    const offenders = [...FILES, path.join(ROOT, "next.config.ts")].filter((f) => /NEXT_PUBLIC_[A-Z_]*WA_CLOUD/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("next.config does not forward it to the browser", () => {
    expect(readFileSync(path.join(ROOT, "next.config.ts"), "utf8")).not.toContain("WA_CLOUD_NUMBER");
  });

  it("a code page learns the official number only from its own code's answer, after the code went from it (PR C7a)", () => {
    // /login, /signup and /claim render no number. After a code is queued,
    // the action's answer names the official number (codeSenderNumber),
    // and only when the code goes from it: the person is about to get a
    // message from that number anyway. The club number never: the reader
    // answers null for it (code-dm.test.ts).
    const callers = FILES.filter((f) => f !== READER && /\bcodeSenderNumber\s*\(/.test(readFileSync(f, "utf8"))).map((f) => path.relative(SRC, f));
    expect(callers).toEqual(["lib/code-dm.ts"]);
    const reader = readFileSync(READER, "utf8");
    const body = reader.slice(reader.indexOf("export function codeSenderNumber("));
    expect(body.slice(0, body.indexOf("\n}\n"))).toMatch(/if \(channel !== "cloud"\) return null;/);
  });

  it("no pool page or component asks for a number by channel (the page renders no number)", () => {
    const callers = FILES.filter((f) => f !== READER && /\bwaNumberFor\s*\(/.test(readFileSync(f, "utf8"))).map((f) => path.relative(SRC, f));
    expect(callers.filter((r) => r.startsWith("app/play/") || r.startsWith("components/pool/"))).toEqual([]);
  });
});
