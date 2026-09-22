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

// ── Phase 4: groups, participants, the LID bridge, polls ─────────────

const groups = source("../baileys/groups.ts");
const polls = source("../baileys/polls.ts");
const pollStore = source("../baileys/poll-store.ts");
const jsonFile = source("../baileys/json-file.ts");
const phoneGate = source("../baileys/phone-gate.ts");
const gateScript = stripComments(
  readFileSync(fileURLToPath(new URL("../../scripts/measure-group-phones.ts", import.meta.url)), "utf8"),
);

describe("Phase 4 still never asks WhatsApp about a number (§2.2)", () => {
  it("no Phase 4 module, nor the gate script, makes a directory lookup", () => {
    const banned = [/onWhatsApp\s*\(/, /executeUSyncQuery\s*\(/, /getLIDForPN\s*\(/, /getLIDsForPNs\s*\(/];
    for (const [name, text] of [
      ["groups", groups],
      ["polls", polls],
      ["poll-store", pollStore],
      ["json-file", jsonFile],
      ["phone-gate", phoneGate],
      ["measure-group-phones", gateScript],
    ] as const) {
      for (const b of banned) expect(text, `${name} ${b}`).not.toMatch(b);
      expect(text, name).not.toMatch(/\.logout\s*\(/);
      expect(text, name).not.toMatch(/\brmSync\b|\brmdir\b|\bunlink(Sync)?\b|\brm\s*\(/);
    }
  });
});

describe("the LID-to-phone bridge is seeded on every sweep (§2.7)", () => {
  it("the driver calls storeLIDPNMappings with pairs from lidPnPairs, where the roster is read", () => {
    // Baileys ships `// TODO: Store LID MAPPINGS` and never seeds its own store.
    expect(driver).toMatch(/storeLIDPNMappings\(/);
    expect(driver).toMatch(/lidPnPairs\(/);
    const seed = driver.indexOf("async function seedFrom");
    expect(seed).toBeGreaterThan(-1);
    const body = driver.slice(seed, driver.indexOf("\n  }\n", seed));
    expect(body.indexOf("lidPnPairs(")).toBeGreaterThan(-1);
    expect(body.indexOf("lidPnPairs(")).toBeLessThan(body.indexOf("storeLIDPNMappings("));
  });

  it("builds pairs in the wire form Baileys' store accepts, never a bare user or an @c.us phone", () => {
    expect(groups).toMatch(/toUserJid\(/);
    expect(groups).not.toMatch(/pn:\s*`\$\{[^}]*\}@c\.us`/);
  });

  it("uses groupMetadata for the roster; the participating listing is for the group list only", () => {
    const read = driver.slice(driver.indexOf("async function readRoster"), driver.indexOf("function handJoin"));
    expect(read).toMatch(/\.groupMetadata\(/);
    expect(read).not.toMatch(/groupFetchAllParticipating/);
    // and it seeds the bridge from what it read, every time it reads.
    expect(read.indexOf(".groupMetadata(")).toBeLessThan(read.indexOf("seedFrom("));
    const sweep = driver.slice(driver.indexOf("async groupParticipants("), driver.indexOf("async groupSnapshot("));
    expect(sweep).toMatch(/readRoster\(/);
    expect(sweep).not.toMatch(/groupFetchAllParticipating/);
  });

  it("wires our own cachedGroupMetadata into the socket", () => {
    expect(driver).toMatch(/cachedGroupMetadata:\s*\(/);
  });
});

describe("poll votes are decrypted by us, from the upsert", () => {
  it("does not wait for messages.update pollUpdates, which rc14 never emits", () => {
    expect(driver).not.toMatch(/["']messages\.update["']/);
    expect(driver).toMatch(/mapPollVote\(/);
  });

  it("archives every poll it sends, so a restart does not cost the remaining votes", () => {
    const sendPoll = driver.slice(driver.indexOf("async sendPoll("), driver.indexOf("async sendReaction("));
    expect(sendPoll).toMatch(/pollArchive\.remember\(/);
  });
});

describe("the phone gate script is read-only", () => {
  it("never sends, never writes a mapping, never touches the database or the API", () => {
    for (const [name, text] of [
      ["phone-gate", phoneGate],
      ["measure-group-phones", gateScript],
    ] as const) {
      expect(text, name).not.toMatch(/\.sendMessage\s*\(/);
      expect(text, name).not.toMatch(/storeLIDPNMappings/);
      expect(text, name).not.toMatch(/prisma|@prisma\/client/i);
      expect(text, name).not.toMatch(/\bfetch\s*\(/);
      expect(text, name).not.toMatch(/from\s+["'][^"']*\/api(\.js)?["']/);
      expect(text, name).not.toMatch(/groupFetchAllParticipating/);
      expect(text, name).not.toMatch(/requestPairingCode/);
    }
  });

  it("reads the group exactly once", () => {
    expect(phoneGate.match(/\.groupMetadata\s*\(/g) ?? []).toHaveLength(1);
    expect(gateScript).not.toMatch(/\.groupMetadata\s*\(/);
  });

  it("closes with end, and chooses the same safe socket options as the driver", () => {
    expect(gateScript).toMatch(/markOnlineOnConnect:\s*false/);
    expect(gateScript).toMatch(/syncFullHistory:\s*false/);
    expect(gateScript).toMatch(/makeBaileysLogger\(/);
    expect(gateScript).toMatch(/acquireInstanceLock\(/);
    expect(gateScript).toMatch(/\.close\(\)/);
  });
});
