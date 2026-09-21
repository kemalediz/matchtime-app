import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * SOURCE-LEVEL INVARIANTS for the Baileys entry point.
 *
 * `main.ts` needs a live socket, and no test in this repo may open one.
 * That is not squeamishness: on 2026-09-17 about a hundred directory
 * lookups from HomeTenant's production account got EVERY linked device on
 * the number unlinked, and both bots went down
 * (`HomeTenant/MDs/learnings.md:262-279`).
 *
 * So all the decisions live in the pure modules beside this file, which are
 * unit-tested properly, and this file pins the handful of wiring rules that
 * only ever show up in the entry point's source text. It is brittle on
 * purpose: each `it()` below is a named incident, and a rename that breaks
 * one of these is a rename that deserves a second look.
 */
const src = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");
// Comments are stripped first, or a comment that says "we never call
// logout()" would fail the assertion that we never call logout().
const code = src
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/\/\*[\s\S]*?\*\//g, "");

describe("the session is never destroyed by us", () => {
  it("never calls logout()", () => {
    // sock.logout() UNLINKS the device. sock.end() closes the socket.
    // Confusing them turns every SIGTERM during a deploy into a re-pair.
    expect(code).not.toMatch(/\.logout\s*\(/);
  });

  it("closes with end() on a signal", () => {
    expect(code).toMatch(/\.end\s*\(/);
  });

  it("never deletes anything from disk", () => {
    expect(code).not.toMatch(/\brmSync\b|\brmdir\b|\bunlink\b|\brm\s*\(/);
  });
});

describe("WhatsApp is never asked about a number", () => {
  it("never calls onWhatsApp", () => {
    // See the file header. This is the call that took HomeTenant's line down.
    expect(code).not.toMatch(/\.onWhatsApp\s*\(/);
  });

  it("never runs a USync directory query", () => {
    expect(code).not.toMatch(/executeUSyncQuery|USyncQuery/);
  });

  it("never asks for a LID by phone number, which goes to the network on a miss", () => {
    expect(code).not.toMatch(/getLIDForPN|getLIDsForPNs/);
  });
});

describe("socket options that are wrong by default", () => {
  it("does not flip the account online, which would steal the phone's notifications", () => {
    expect(code).toMatch(/markOnlineOnConnect:\s*false/);
  });

  it("chooses syncFullHistory explicitly rather than taking the default of true", () => {
    expect(code).toMatch(/syncFullHistory:\s*(true|false)/);
  });

  it("does not use the deprecated printQRInTerminal", () => {
    expect(code).not.toMatch(/printQRInTerminal/);
  });

  it("passes the redacting logger, never a raw pino", () => {
    expect(code).toMatch(/logger/);
    expect(code).not.toMatch(/require\(['"]pino|from\s+['"]pino['"]/);
  });
});

describe("this phase observes and does not act", () => {
  it("sends nothing", () => {
    // Phase 1 runs beside the live bot. Two linked devices both sending is
    // the 2026-07-19 duplicate flood.
    expect(code).not.toMatch(/\.sendMessage\s*\(/);
    expect(code).not.toMatch(/sendPresenceUpdate|readMessages/);
  });

  it("does not start the scheduler, the flush timer or the org refresh", () => {
    expect(code).not.toMatch(/initScheduler|startBatchFlushTimer|startOrgRefreshTimer/);
  });

  it("does not call the MatchTime server", () => {
    expect(code).not.toMatch(/from\s+["']\.\.\/api\.js["']/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("it does not disturb the running bot", () => {
  it("never imports the whatsapp-web.js entry point or its client", () => {
    expect(code).not.toMatch(/whatsapp-web\.js/);
    expect(code).not.toMatch(/from\s+["']\.\.\/index\.js["']/);
  });

  it("uses its own lock path, so it cannot be mistaken for the live instance", () => {
    expect(code).toMatch(/MT_BOT_LOCK_PATH|baileys.*lock|lock.*baileys/i);
  });
});

describe("the decisions live in the tested modules, not here", () => {
  it("delegates the close decision to decideOnClose", () => {
    expect(code).toMatch(/decideOnClose\s*\(/);
  });

  it("delegates pairing to decidePairingAction", () => {
    expect(code).toMatch(/decidePairingAction\s*\(/);
  });

  it("delegates message mapping to mapInboundMessage", () => {
    expect(code).toMatch(/mapInboundMessage\s*\(/);
  });

  it("drops uninteresting chats before it does anything with a message", () => {
    const drop = code.indexOf("inboundDropReason(");
    const map = code.indexOf("mapInboundMessage(");
    expect(drop).toBeGreaterThan(-1);
    expect(map).toBeGreaterThan(-1);
    expect(drop).toBeLessThan(map);
  });

  it("guards against a stale socket's events with a generation counter", () => {
    // Every reconnect makes a new socket; the old one's handlers keep
    // firing unless they check.
    expect(code).toMatch(/generation/);
  });

  it("logs the upsert type, which is the measurement Phase 5 depends on", () => {
    // Whether messages sent while the Pi was down arrive as "append" or
    // "notify" decides whether recoverGroupMessages can be retired.
    expect(code).toMatch(/type/);
    expect(code).not.toMatch(/if\s*\(\s*type\s*!==\s*["']notify["']\s*\)\s*return/);
  });
});
