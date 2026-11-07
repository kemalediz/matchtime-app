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
const PLATFORM_JOBS = "lib/platform-jobs.ts";

const SEND_CHANNEL_IMPORT = /from\s+["'](?:@\/lib\/send-channel|\.{1,2}\/(?:[\w-]+\/)*send-channel)["']|import\(\s*["'][^"']*send-channel["']\s*\)/;

/** Files that may call the deciding functions. Extend deliberately. */
const CHANNEL_CALLERS = new Set<string>([
  // waNumberFor lives here, next to the club number's reader, and asks
  // nothing: it turns a decided channel into digits.
  NUMBER_READER,
  // PR C2: queuePlatformDm asks once and stores the answer on the job.
  PLATFORM_JOBS,
]);

/** PR C4: the Cloud dispatcher. It asks the master switch (`cloudApiEnabled`)
 *  and, for a send that failed, `fallbackWhenCloudDown`; its pure rules read
 *  `ANSWER_PURPOSES` to put answers first. Neither picks a job's channel. */
const CLOUD_DISPATCH = "lib/cloud-api/dispatch.ts";
const CLOUD_DISPATCH_RULES = "lib/cloud-api/dispatch-rules.ts";

/** PR C5: the Cloud webhook. It asks the master switch (`cloudApiEnabled`)
 *  and labels what came in on the official number; it picks no channel
 *  for anything sent. */
const CLOUD_WEBHOOK = "lib/cloud-api/webhook.ts";

/** Files that may import send-channel (types included). Extend deliberately. */
const CHANNEL_IMPORTERS = new Set<string>([NUMBER_READER, PLATFORM_JOBS, CLOUD_DISPATCH, CLOUD_DISPATCH_RULES, CLOUD_WEBHOOK]);

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

describe("a PlatformJob's channel is decided once, in queuePlatformDm (PR C2)", () => {
  const src = code(path.join(SRC, PLATFORM_JOBS));

  it("platform-jobs.ts calls channelFor exactly once, and nothing else from send-channel", () => {
    expect(src.match(/\bchannelFor\s*\(/g) ?? []).toHaveLength(1);
    expect(src).not.toMatch(/\b(waLinkChannelFor|waNumberFor|fallbackWhenCloudDown)\s*\(/);
  });

  it("that one call is inside queuePlatformDm, and its answer is what the job stores", () => {
    const start = src.indexOf("export async function queuePlatformDm(");
    const end = src.indexOf("\nexport ", start + 1);
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, end);
    expect(body).toMatch(/\bchannelFor\s*\(/);
    expect(body).toMatch(/\bchannel,/);
  });

  it("only a handover changes a job's channel, and only the Cloud dispatcher asks for one, with fallbackWhenCloudDown's answer (PR C4)", () => {
    // platform-jobs.ts writes `channel: result.channel` for a handover and
    // nowhere else after queuePlatformDm.
    expect(src.match(/\bchannel:\s*result\.channel\b/g) ?? []).toHaveLength(1);
    // Outside platform-jobs.ts itself, where the outcome is defined.
    const askers = FILES.filter((f) => rel(f) !== PLATFORM_JOBS && /outcome:\s*["']handover["']/.test(code(f))).map(rel);
    expect(askers).toEqual([CLOUD_DISPATCH]);
    const dispatch = code(path.join(SRC, CLOUD_DISPATCH));
    expect(dispatch).toMatch(/const fallback = fallbackWhenCloudDown\(/);
    expect(dispatch).toMatch(/outcome:\s*"handover",\s*channel:\s*fallback\b/);
  });

  it("the Cloud dispatcher names the official number once, as the channel it claims for", () => {
    const dispatch = code(path.join(SRC, CLOUD_DISPATCH));
    expect(dispatch.match(/["']cloud["']/g) ?? []).toHaveLength(1);
    expect(dispatch).toMatch(/const OFFICIAL_NUMBER: SendChannel = "cloud";/);
    expect(dispatch).not.toMatch(/\b(channelFor|waLinkChannelFor|waNumberFor)\s*\(/);
  });

  it("the Cloud webhook names the official number once, asks only the master switch, and never changes a job's channel (PR C5)", () => {
    const hook = code(path.join(SRC, CLOUD_WEBHOOK));
    expect(hook.match(/["']cloud["']/g) ?? []).toHaveLength(1);
    expect(hook).toMatch(/const OFFICIAL_NUMBER: SendChannel = "cloud";/);
    expect(hook).not.toMatch(/\b(channelFor|waLinkChannelFor|waNumberFor|fallbackWhenCloudDown)\s*\(/);
    expect(hook).not.toMatch(/data:\s*\{[^}]*\bchannel\b/);
  });

  it("a code DM has one door, src/lib/code-dm.ts, which picks no channel (PR C7a)", () => {
    // Every code (sign-up, sign-in, claim) is queued by queueCodeDm, so
    // each one carries mt_code; nothing else writes purpose "otp".
    // `purpose: "otp"` followed by a comma or brace is a value in an object
    // literal (a queue call); `purpose: "otp" | ...` in platform-jobs.ts is
    // a type in its claim reader.
    const otpQueuers = FILES.filter((f) => /\bpurpose:\s*["']otp["']\s*[,}]/.test(code(f))).map(rel);
    expect(otpQueuers).toEqual(["lib/code-dm.ts"]);
    const door = code(path.join(SRC, "lib/code-dm.ts"));
    expect(door).toMatch(/\bqueuePlatformDm\s*\(/);
    expect(door).toMatch(/name:\s*"mt_code"/);
    expect(door).not.toMatch(SEND_CHANNEL_IMPORT);
    expect(door).not.toMatch(/\b(channelFor|waLinkChannelFor|waNumberFor)\s*\(/);
    // Its callers are the three code actions, and nothing else.
    const callers = FILES.filter((f) => rel(f) !== "lib/code-dm.ts" && /\bqueueCodeDm\s*\(/.test(code(f))).map(rel);
    expect(callers.sort()).toEqual(["app/actions/claim.ts", "app/actions/phone-signup.ts"]);
  });

  it("the page's number for a code comes only through the code door (PR C7a)", () => {
    const callers = FILES.filter((f) => rel(f) !== NUMBER_READER && /\bcodeSenderNumber\s*\(/.test(code(f))).map(rel);
    expect(callers).toEqual(["lib/code-dm.ts"]);
  });

  it("every other PlatformJob writer leaves channel to the column default (baileys)", () => {
    const writers = FILES.filter((f) => /platformJob\s*\.\s*(create|createMany|upsert)\s*\(/.test(code(f))).map(rel);
    expect(writers.sort()).toEqual(["lib/owner-dm.ts", PLATFORM_JOBS].sort());
    expect(code(path.join(SRC, "lib/owner-dm.ts"))).not.toMatch(/\bchannel\b/);
  });
});
