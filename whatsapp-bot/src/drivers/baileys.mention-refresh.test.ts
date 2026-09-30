/**
 * `refreshGroupRoster` on the Baileys driver (2026-09-30): ONE fresh
 * `groupMetadata`, past the fifteen-minute roster cache, that teaches the
 * LID-to-phone pairs of a player added since the last read; at most once
 * per group per ten minutes.
 */
import { describe, it, expect } from "vitest";
import type { GroupMetadata } from "baileys";
import { FakeSocket, manualScheduler } from "../baileys/fake-socket.js";
import { createBaileysConnection } from "../baileys/lifecycle.js";
import { createSessionLedger } from "../baileys/session-ledger.js";
import { createPollArchive } from "../baileys/poll-store.js";
import { MENTION_ROSTER_REFRESH_INTERVAL_MS } from "../baileys/roster-refresh.js";
import { makeBaileysDriver } from "./baileys.js";

const GROUP = "120363408471622062@g.us";
const ME_PN = "447700900001@s.whatsapp.net";
const ME_LID = "158000000000001@lid";
const DAVID_LID = "252012071493723@lid";
const DAVID_PN = "447881432810@s.whatsapp.net";

const tick = () => new Promise((r) => setImmediate(r));

function roster(withDavid: boolean): GroupMetadata {
  return {
    id: GROUP,
    subject: "MT Test",
    addressingMode: "lid",
    owner: undefined,
    participants: [
      { id: ME_LID, phoneNumber: ME_PN, admin: null },
      ...(withDavid ? [{ id: DAVID_LID, phoneNumber: DAVID_PN, admin: null }] : []),
    ],
  } as GroupMetadata;
}

async function started() {
  let t = 1_000_000;
  const sockets: FakeSocket[] = [];
  const connection = createBaileysConnection<FakeSocket>({
    makeSocket: () => {
      const s = new FakeSocket();
      s.groups = { [GROUP]: roster(false) };
      sockets.push(s);
      return s;
    },
    pairPhone: "",
    ledger: createSessionLedger({ load: () => null, save: () => {} }),
    printQr: () => {},
    schedule: manualScheduler().schedule,
    exit: () => {},
    log: () => {},
    error: () => {},
  });
  const now = () => t;
  const driver = makeBaileysDriver({
    connection: connection as never,
    pollArchive: createPollArchive({ io: { load: () => null, save: () => {} }, now }),
    now,
    log: () => {},
    error: () => {},
  });
  await driver.start();
  sockets[sockets.length - 1].open();
  await tick();
  const sock = () => sockets[sockets.length - 1];
  return { driver, sock, advance: (ms: number) => (t += ms) };
}

describe("Baileys refreshGroupRoster", () => {
  it("re-reads past the cache and teaches a new member's phone", async () => {
    const t = await started();
    await t.driver.groupParticipants(GROUP); // cached roster, David not in it
    t.sock().groups[GROUP] = roster(true); // David added since
    expect(((await t.driver.getContact(DAVID_LID)) as { number?: string }).number).toBeUndefined();

    expect(await t.driver.refreshGroupRoster!(GROUP)).toBe(true);
    expect(t.sock().metadataCalls).toEqual([GROUP, GROUP]);
    expect(((await t.driver.getContact(DAVID_LID)) as { number?: string }).number).toBe("447881432810");
  });

  it("is limited to one read per group per window", async () => {
    const t = await started();
    expect(await t.driver.refreshGroupRoster!(GROUP)).toBe(true);
    expect(await t.driver.refreshGroupRoster!(GROUP)).toBe(false);
    expect(t.sock().metadataCalls).toEqual([GROUP]);
    t.advance(MENTION_ROSTER_REFRESH_INTERVAL_MS);
    expect(await t.driver.refreshGroupRoster!(GROUP)).toBe(true);
    expect(t.sock().metadataCalls).toEqual([GROUP, GROUP]);
  });

  it("returns false, never throws, when the read fails", async () => {
    const t = await started();
    t.sock().groupMetadata = async () => {
      throw new Error("timed out");
    };
    expect(await t.driver.refreshGroupRoster!(GROUP)).toBe(false);
  });
});
