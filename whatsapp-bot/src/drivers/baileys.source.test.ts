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
