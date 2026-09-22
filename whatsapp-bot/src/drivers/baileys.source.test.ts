/**
 * SOURCE-LEVEL INVARIANTS for the Baileys driver.
 *
 * Same technique as `src/baileys/main.source.test.ts` and HomeTenant's
 * `tests/baileys-driver-source.test.ts`: read the file, strip comments,
 * assert on the text. Brittle on purpose. Each `it()` is a named incident
 * or a named hazard from `MDs/baileys-migration-plan-2026-09-21.md`, and a
 * change that breaks one deserves a second look before the test is edited.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const driver = stripComments(
  readFileSync(fileURLToPath(new URL("./baileys.ts", import.meta.url)), "utf8"),
);
const outbound = stripComments(
  readFileSync(fileURLToPath(new URL("../baileys/outbound.ts", import.meta.url)), "utf8"),
);

describe("the session is never destroyed by us (§2.10)", () => {
  it("never calls logout(): it unlinks the device and turns a deploy into a re-pair", () => {
    expect(driver).not.toMatch(/\.logout\s*\(/);
  });

  it("closes with end(undefined)", () => {
    expect(driver).toMatch(/\.end\(undefined\)/);
  });

  it("never deletes anything from disk", () => {
    expect(driver).not.toMatch(/\brmSync\b|\brmdir\b|\bunlink\b|\brm\s*\(/);
  });
});

describe("we never ask WhatsApp about a number (§2.2)", () => {
  it("has no directory lookup of any kind", () => {
    // About a hundred of these from HomeTenant's production account got
    // every linked device on the number unlinked on 2026-09-17.
    for (const banned of [/onWhatsApp\s*\(/, /executeUSyncQuery\s*\(/, /getLIDForPN\s*\(/, /getLIDsForPNs\s*\(/]) {
      expect(driver).not.toMatch(banned);
      expect(outbound).not.toMatch(banned);
    }
  });
});

describe("every text goes out with link previews off (§2.6)", () => {
  it("has exactly one call to sock.sendMessage, inside the one send helper", () => {
    // One door means every message, reactions and polls included, passes
    // the connection check and lands in the getMessage store.
    expect(driver.match(/\.sendMessage\s*\(/g) ?? []).toHaveLength(1);
  });

  it("never builds a bare { text } in the driver: texts come from textContent or mentionContent", () => {
    // A bare `{ text }` leaves linkPreview undefined, which is Baileys'
    // "generate one", which makes the Pi fetch the URL we are sending.
    // MatchTime sends short magic links, which are credentials.
    expect(driver).not.toMatch(/\{\s*text(\s*[,}]|\s*:)/);
    expect(driver).toMatch(/textContent\(/);
    expect(driver).toMatch(/mentionContent\(/);
  });

  it("builds every text object in outbound.ts with linkPreview: null next to it", () => {
    // A reaction's `{ text: emoji, key }` is the one `text` that is not a
    // message body, and Baileys never previews it.
    const texts = [...outbound.matchAll(/(react:\s*)?\{\s*text\b[^}]*\}/g)]
      .filter((m) => !m[1])
      .map((m) => m[0]);
    expect(texts.length).toBeGreaterThanOrEqual(3);
    for (const t of texts) expect(t, t).toMatch(/linkPreview:\s*null/);
  });
});

describe("ids stay in the format the database already holds (§2.5)", () => {
  it("serialises sent keys and parses reaction targets with the tested pair, not by hand", () => {
    expect(driver).toMatch(/serializeKey\(/);
    expect(driver).toMatch(/parseKey\(/);
    // No hand-built `${fromMe}_${remote}` template anywhere in the driver.
    expect(driver).not.toMatch(/\$\{[^}]*fromMe[^}]*\}_/);
  });

  it("completes our own group keys before serialising them", () => {
    const helper = driver.indexOf("completeOwnKey(");
    const serialise = driver.indexOf("serializeKey(");
    expect(helper).toBeGreaterThan(-1);
    expect(helper).toBeLessThan(serialise);
  });
});

// ── Phase 3b: lifecycle, identity and inbound ────────────────────────

function source(rel: string): string {
  return stripComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
}

const lifecycle = source("../baileys/lifecycle.ts");
const ledger = source("../baileys/session-ledger.ts");
const reaction = source("../baileys/reaction.ts");
const contacts = source("../baileys/contacts.ts");
const inboundView = source("../baileys/inbound-view.ts");

describe("Phase 3b never destroys the session either (§2.10)", () => {
  it("has no logout() anywhere in the lifecycle", () => {
    expect(lifecycle).not.toMatch(/\.logout\s*\(/);
  });

  it("deletes nothing from disk: not the auth folder, not the ledger", () => {
    for (const [name, text] of [
      ["driver", driver],
      ["lifecycle", lifecycle],
      ["session-ledger", ledger],
    ] as const) {
      expect(text, name).not.toMatch(/\brmSync\b|\brmdir\b|\bunlink(Sync)?\b|\brm\s*\(/);
    }
  });
});

describe("names and numbers are harvested, never looked up (§2.2, §2.9)", () => {
  it("no Phase 3b module asks WhatsApp about a number or a profile", () => {
    const banned = [
      /onWhatsApp\s*\(/,
      /executeUSyncQuery\s*\(/,
      /getLIDForPN\s*\(/,
      /getLIDsForPNs\s*\(/,
      /fetchStatus\s*\(/,
      /profilePictureUrl\s*\(/,
      /getBusinessProfile\s*\(/,
    ];
    for (const [name, text] of [
      ["driver", driver],
      ["lifecycle", lifecycle],
      ["reaction", reaction],
      ["contacts", contacts],
      ["inbound-view", inboundView],
    ] as const) {
      for (const b of banned) expect(text, `${name} ${b}`).not.toMatch(b);
    }
  });

  it("reads LID mappings only through getPNForLID, the local-only direction", () => {
    expect(driver).toMatch(/getPNForLID\(/);
  });
});

describe("the socket options that are wrong by default (§2.13)", () => {
  it("does not flip the account online, which would steal the phone's notifications", () => {
    expect(driver).toMatch(/markOnlineOnConnect:\s*false/);
  });

  it("chooses syncFullHistory explicitly rather than taking the default of true", () => {
    expect(driver).toMatch(/syncFullHistory:\s*false/);
  });

  it("wires getMessage, without which a recipient's retry shows 'waiting for this message'", () => {
    expect(driver).toMatch(/getMessage:\s*\(/);
  });

  it("does not use the deprecated printQRInTerminal", () => {
    expect(driver).not.toMatch(/printQRInTerminal/);
  });

  it("passes the redacting logger, never a raw pino", () => {
    expect(driver).toMatch(/makeBaileysLogger\(/);
    expect(driver).not.toMatch(/from\s+["']pino["']/);
  });
});

describe("the offline-replay measurement stays possible (§2.15)", () => {
  it("never filters inbound messages on the upsert type", () => {
    // HomeTenant's `if (type !== "notify") return;` is exactly the line that
    // makes its production experience useless as evidence. Not here.
    expect(driver).not.toMatch(/["']notify["']/);
    expect(driver).not.toMatch(/["']append["']/);
  });

  it("logs the upsert type", () => {
    expect(driver).toMatch(/upsert=\$\{/);
  });
});

describe("pairing is rationed (runbook §5)", () => {
  it("calls requestPairingCode in exactly one place, after the ledger has said yes", () => {
    expect(lifecycle.match(/\.requestPairingCode\s*\(/g) ?? []).toHaveLength(1);
    expect(driver).not.toMatch(/\.requestPairingCode\s*\(/);
    const ask = lifecycle.indexOf(".requestPairingCode(");
    const budget = lifecycle.indexOf("tryPairingRequest(");
    expect(budget).toBeGreaterThan(-1);
    expect(budget).toBeLessThan(ask);
  });

  it("delegates the close decision to decideOnClose and guards stale sockets", () => {
    expect(lifecycle).toMatch(/decideOnClose\(/);
    expect(lifecycle).toMatch(/gen\s*!==\s*generation/);
  });
});

describe("a reaction's target is resolved BEFORE it is serialised", () => {
  it("serialises only after the LID-to-phone step, with the tested serialiser", () => {
    // Slice mapReaction out by name: inside it, the target must go through
    // resolveTarget (where the LID becomes a phone) before serializeKey.
    const start = reaction.indexOf("export async function mapReaction");
    const end = reaction.indexOf("async function resolveTarget");
    const map = reaction.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(map.indexOf("resolveTarget(")).toBeGreaterThan(-1);
    expect(map.indexOf("resolveTarget(")).toBeLessThan(map.indexOf("serializeKey(resolved.key)"));
    // And inside resolveTarget, the DM key's remote is replaced by the phone.
    const target = reaction.slice(end, reaction.indexOf("async function reactorId"));
    expect(target).toMatch(/phoneForLid\(/);
    expect(target).toMatch(/remoteJid:\s*toUserJid\(phone\)/);
    expect(reaction).not.toMatch(/\$\{[^}]*fromMe[^}]*\}_/);
  });
});
