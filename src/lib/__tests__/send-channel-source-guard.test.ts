/**
 * SOURCE GUARDS: ONE PLACE PICKS THE CHANNEL (WhatsApp Cloud API plan,
 * PR C1; MDs/whatsapp-cloud-api-plan-2026-11-04.md section 5.1).
 *
 * Kemal (4 Nov 2026): the club number (Baileys on the Pi) keeps the club
 * groups, HQ and DMs to members; the official number (Cloud API) gets the
 * first contact with strangers and the codes. One ban of the club number
 * takes down every club at once, so which number a message uses must be
 * decided in exactly one place, where a review can see it:
 *
 *   1. the flags `CLOUD_API_ENABLED` and `CLOUD_API_PURPOSES` are read
 *      only by src/lib/send-channel.ts;
 *   2. the official number `WA_CLOUD_NUMBER` is read only by
 *      src/lib/club-connect.ts, the server only reader of the club number
 *      (wa-number-server-only.test.ts covers both);
 *   3. `channelFor`, `waLinkChannelFor` and `waNumberFor` are called only
 *      from an allowlist. Adding a caller means editing this file, on
 *      purpose, in review (PR C2 adds queuePlatformDm, PR C7b the wa.me
 *      links);
 *   4. send-channel.ts stays pure: type imports only, no database, no
 *      network, nothing awaited;
 *   5. a BotJob (club DMs, HQ, group posts) never asks: no file that
 *      writes a BotJob imports send-channel.
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
const CHANNEL_MODULE = "lib/send-channel.ts";
const NUMBER_READER = "lib/club-connect.ts";

const SEND_CHANNEL_IMPORT = /from\s+["'](?:@\/lib\/send-channel|\.{1,2}\/(?:[\w-]+\/)*send-channel)["']|import\(\s*["'][^"']*send-channel["']\s*\)/;

/** Files that may call the deciding functions. Extend deliberately. */
const CHANNEL_CALLERS = new Set<string>([
  // waNumberFor lives here, next to the club number's reader, and asks
  // nothing: it turns a decided channel into digits.
  NUMBER_READER,
]);

/** Files that may import send-channel (types included). Extend deliberately. */
const CHANNEL_IMPORTERS = new Set<string>([NUMBER_READER]);

describe("the flags are read in one place", () => {
  it("only send-channel.ts reads CLOUD_API_ENABLED or CLOUD_API_PURPOSES", () => {
    const readers = FILES.filter((f) => /CLOUD_API_(ENABLED|PURPOSES)/.test(code(f))).map(rel);
    expect(readers).toEqual([CHANNEL_MODULE]);
  });

  it("only club-connect.ts reads WA_CLOUD_NUMBER", () => {
    const readers = FILES.filter((f) => /WA_CLOUD_NUMBER/.test(code(f))).map(rel);
    expect(readers).toEqual([NUMBER_READER]);
  });
});

describe("nothing else picks a channel", () => {
  it("channelFor, waLinkChannelFor and waNumberFor are called only from the allowlist", () => {
    const callers = FILES.filter((f) => rel(f) !== CHANNEL_MODULE && /\b(channelFor|waLinkChannelFor|waNumberFor)\s*\(/.test(code(f)))
      .map(rel)
      .filter((f) => !CHANNEL_CALLERS.has(f));
    expect(callers).toEqual([]);
  });

  it("send-channel is imported only from the allowlist", () => {
    const importers = FILES.filter((f) => SEND_CHANNEL_IMPORT.test(code(f)))
      .map(rel)
      .filter((f) => !CHANNEL_IMPORTERS.has(f));
    expect(importers).toEqual([]);
  });

  it("no file outside the two homes names the official number's channel switch in code", () => {
    // A hand rolled `channel: "cloud"` elsewhere would be a second decider.
    const offenders = FILES.filter((f) => ![CHANNEL_MODULE, NUMBER_READER].includes(rel(f)))
      .filter((f) => /\bchannel\s*[:=]{1,3}\s*["']cloud["']/.test(code(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("the matchers are not vacuous", () => {
    expect(SEND_CHANNEL_IMPORT.test(`import { channelFor } from "@/lib/send-channel";`)).toBe(true);
    expect(SEND_CHANNEL_IMPORT.test(`import type { SendChannel } from "./send-channel";`)).toBe(true);
    expect(SEND_CHANNEL_IMPORT.test(`const m = await import("@/lib/send-channel");`)).toBe(true);
    expect(SEND_CHANNEL_IMPORT.test(`import { x } from "@/lib/club-connect";`)).toBe(false);
    expect(FILES.map(rel)).toContain(CHANNEL_MODULE);
    expect(FILES.filter((f) => /\bwaNumberFor\s*\(/.test(code(f))).map(rel)).toContain(NUMBER_READER);
  });
});

describe("send-channel.ts is pure", () => {
  const src = code(path.join(SRC, CHANNEL_MODULE));

  it("has type imports only", () => {
    const imports = src.split("\n").filter((l) => /^\s*import\s/.test(l));
    expect(imports.filter((l) => !/^\s*import\s+type\s/.test(l))).toEqual([]);
  });

  it("touches no database, network or clock", () => {
    expect(src).not.toMatch(/\bdb\./);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/\bawait\b/);
    expect(src).not.toMatch(/\basync\b/);
    expect(src).not.toMatch(/new Date\(|Date\.now\(/);
  });
});

describe("a BotJob never asks for a channel", () => {
  it("no file that writes a BotJob imports send-channel", () => {
    const writers = FILES.filter((f) => /botJob\s*\.\s*(create|createMany|upsert)\s*\(/.test(code(f)));
    expect(writers.length).toBeGreaterThan(3);
    expect(writers.filter((f) => SEND_CHANNEL_IMPORT.test(code(f))).map(rel)).toEqual([]);
  });
});
