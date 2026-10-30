/**
 * THE LAST FOUR WORD READERS STAY DELETED (2026-10-30, the final sweep of
 * Kemal's rule: "I don't want any string parsing at all").
 *
 *   1. the admin group link: the words "Match Time" typed counted as a tag,
 *      and the phrase "admin group" / "yönetici grubu" made it the link
 *      message (`parseAdminGroupLinkMessage`, and its copy on the Pi). Now
 *      the Pi's mention flag, a code we issued, and who sent it where;
 *   2. the connect DM's wrong-code reply: a verb list (connect / bağla,
 *      `looksLikeConnectMessage`). Now the one DM reader, after the facts;
 *   3. the owner's "APPROVE / REJECT <ref>" regex (`parseApproverCommand`).
 *      Now the one DM reader, gated on the owner's number, its ref checked
 *      against his words;
 *   4. the learned setup's fee: a word list for the whole pitch and for a
 *      price per player (`pricesIn`, `statesPrice`), and a reading of the
 *      chat for other prices (`chatSaysOtherwise`). Now the model's
 *      `basis`, and a check that the quote holds the number.
 *
 * Pinned here by reading the sources (comments taken out, so a history
 * note never trips it). What stays allowed: codes we issued (the
 * code-shaped token, the connect code after "code"/"kod" in our own
 * prefill), phone numbers, the mention flag, and verifiers of a model's
 * answer (a ref in his words, a number in a quote).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === "generated") continue;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}
const isTest = (f: string) => /__tests__|\.test\.tsx?$/.test(f);
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = (rel: string) => strip(readFileSync(path.join(ROOT, rel), "utf8"));

const PROD = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "whatsapp-bot", "src"))].filter((f) => !isTest(f));

const DELETED = [
  "parseAdminGroupLinkMessage",
  "LINK_COMMAND",
  "looksLikeConnectMessage",
  "CONNECT_VERB_RE",
  "parseApproverCommand",
  "COMMAND_RE",
  "pricesIn",
  "statesPrice",
  "chatSaysOtherwise",
  "WHOLE_PITCH_RE",
  "PER_PLAYER_RE",
];

/** Every regex in a source: its literals and its `new RegExp(...)` bodies. */
function regexesIn(src: string): string[] {
  const literals = [...src.matchAll(/(?:[(=,:!&|?]|return)\s*(\/(?![/*])(?:\\.|\[(?:\\.|[^\]\n])*\]|[^/\n\\])+\/[dgimsuy]*)/g)].map((m) => m[1]);
  // A template's `${...}` names our own constants (the code alphabet), not words.
  const built = [...src.matchAll(/new RegExp\(([\s\S]*?)\)\s*[;,]/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, ""));
  return [...literals, ...built];
}

describe("the four readers are gone", () => {
  it("no production file, on the server or the Pi, defines, imports or calls one", () => {
    expect(existsSync(path.join(ROOT, "whatsapp-bot", "src", "admin-group.ts"))).toBe(true);
    const hits: string[] = [];
    for (const f of PROD) {
      const src = strip(readFileSync(f, "utf8"));
      for (const name of DELETED) if (new RegExp(`\\b${name}\\b`).test(src)) hits.push(`${path.relative(ROOT, f)}: ${name}`);
    }
    expect(hits).toEqual([]);
  });
});

describe("no regex in these files reads a word of what a person meant", () => {
  const WORDS: Array<[string, RegExp]> = [
    ["src/lib/admin-channel-rules.ts", /match|time|admin|group|y\[?o|netici|grub/i],
    ["src/lib/admin-group-link.ts", /match|time|admin|group|netici|grub/i],
    ["whatsapp-bot/src/admin-group.ts", /match|time|admin|group|netici|grub/i],
    ["src/lib/connect-dm-rules.ts", /connect|ba\[?[ğg]|la\b/i],
    ["src/lib/connect-dm.ts", /connect|ba\[?[ğg]/i],
    ["src/lib/club-decision-rules.ts", /approve|reject|onay|redd/i],
    ["src/lib/club-approval.ts", /approve|reject|onay|redd/i],
    ["src/lib/setup-learning/rules.ts", /pitch|saha|total|toplam|each|head|person|player|ki[şs]i|adam|quid|pound|gbp/i],
  ];
  it.each(WORDS)("%s", (rel, words) => {
    expect(regexesIn(code(rel)).filter((r) => words.test(r))).toEqual([]);
  });

  it("the guard's regex finder does see a regex (it would have caught the old readers)", () => {
    const old = 'const COMMAND_RE = /^(approve|reject)(?:[\\s:,-]+([a-z0-9]{2,8}))?[\\s.!]*$/i;\nconst X = new RegExp("(?:pitch|saha)", "iu");';
    expect(regexesIn(old).length).toBe(2);
    expect(regexesIn(old).filter((r) => /approve|pitch/.test(r))).toHaveLength(2);
  });
});

describe("the facts that replaced them", () => {
  it("the admin group link reads the Pi's mention flag, never the words: no text test of 'match time' anywhere in it", () => {
    const link = code("src/lib/admin-group-link.ts");
    expect(link).toMatch(/input\.botMentioned !== true/);
    expect(link).toMatch(/adminGroupCodeCandidates\(input\.text\)/);
    expect(link).toMatch(/awaitingAdminLink: true/);
    expect(code("whatsapp-bot/src/admin-group.ts")).toMatch(/botMentioned === true && /);
  });

  it("the wrong-code reply and the owner's decision consult the one DM reader, after their facts", () => {
    const connect = code("src/lib/connect-dm.ts");
    expect(connect.indexOf("phones.includes(open.phone)")).toBeLessThan(connect.indexOf("input.read(open.userId)"));
    expect(connect).toMatch(/read\.intent !== CONNECT_CLUB_INTENT/);
    const approval = code("src/lib/club-approval.ts");
    expect(approval.indexOf("isApproverSender(input, approvers)")).toBeLessThan(approval.indexOf("await input.read("));
    expect(approval).toMatch(/approverCommandFromRead\(/);
  });

  it("the fee is kept on the model's basis and a number in the quote, nothing else", () => {
    const rules = code("src/lib/setup-learning/rules.ts");
    expect(rules).toMatch(/o\.basis !== "per_player"/);
    expect(rules).toMatch(/quoteHasAmount\(q, n\)/);
    expect(rules).not.toMatch(/src\.history\.some\(/);
  });
});
