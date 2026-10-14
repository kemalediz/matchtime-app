/**
 * The Baileys driver keeps, per group, whether MatchTime can post there
 * (2026-10-14, group-postability.ts), from every metadata read and every
 * group settings or promote/demote event, against a fake socket.
 */
import { describe, expect, it } from "vitest";
import type { GroupMetadata } from "baileys";
import { FakeSocket, manualScheduler } from "../baileys/fake-socket.js";
import { createBaileysConnection } from "../baileys/lifecycle.js";
import { createSessionLedger } from "../baileys/session-ledger.js";
import type { GroupPostability } from "../group-postability.js";
import { makeBaileysDriver } from "./baileys.js";

const ANNOUNCE = "120363000000000001@g.us";
const OPEN = "120363000000000002@g.us";
const COMMUNITY = "120363000000000003@g.us";
const ME_PN = "447700900001@s.whatsapp.net";
const ME_LID = "158000000000001@lid";

const tick = () => new Promise((r) => setImmediate(r));

function group(id: string, over: Partial<GroupMetadata> = {}, meAdmin: "admin" | null = null): GroupMetadata {
  return {
    id,
    subject: "A group",
    addressingMode: "lid",
    owner: undefined,
    announce: false,
    isCommunityAnnounce: false,
    participants: [
      { id: ME_LID, phoneNumber: ME_PN, admin: meAdmin },
      { id: "158055467598021@lid", phoneNumber: "447700900124@s.whatsapp.net", admin: "superadmin" },
    ],
    ...over,
  } as GroupMetadata;
}

async function started() {
  const sockets: FakeSocket[] = [];
  const connection = createBaileysConnection<FakeSocket>({
    makeSocket: () => {
      const s = new FakeSocket();
      s.groups = {
        [ANNOUNCE]: group(ANNOUNCE, { announce: true }),
        [OPEN]: group(OPEN),
        [COMMUNITY]: group(COMMUNITY, { announce: true, isCommunityAnnounce: true, linkedParent: "120363000000000777@g.us" }),
      };
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
  const logs: string[] = [];
  const driver = makeBaileysDriver({ connection: connection as never, now: () => 1_000_000, log: (l) => logs.push(l), error: (l) => logs.push(l) });
  const changes: Array<{ gid: string; p: GroupPostability }> = [];
  driver.onGroupPostability?.((gid, p) => changes.push({ gid, p }));
  await driver.start();
  sockets[sockets.length - 1].open();
  await tick();
  return { driver, sock: () => sockets[sockets.length - 1], changes, logs };
}

describe("Baileys driver: group postability", () => {
  it("has no reading before any group is read: nothing is gated", async () => {
    const t = await started();
    expect(t.driver.groupPostability?.(ANNOUNCE)).toBeUndefined();
  });

  it("the group list read at open gives every group a reading", async () => {
    const t = await started();
    // The listing drops phones; MatchTime is still found by its LID.
    await t.driver.listGroups();
    expect(t.driver.groupPostability?.(ANNOUNCE)?.reason).toBe("admin-only");
    expect(t.driver.groupPostability?.(OPEN)?.canPost).toBe(true);
    expect(t.driver.groupPostability?.(COMMUNITY)?.reason).toBe("community-announce");
    expect(t.changes.map((c) => c.gid).sort()).toEqual([ANNOUNCE, OPEN, COMMUNITY].sort());
  });

  it("a roster read (groupSnapshot) carries the reading to the self-add", async () => {
    const t = await started();
    const snap = await t.driver.groupSnapshot(ANNOUNCE, await t.driver.selfIds());
    expect(snap.postability).toMatchObject({ announce: true, botIsAdmin: false, canPost: false, reason: "admin-only" });
  });

  it("the setting switched off (groups.update announce=false): can post again", async () => {
    const t = await started();
    await t.driver.listGroups();
    t.sock().emit("groups.update", [{ id: ANNOUNCE, announce: false, author: ME_LID }]);
    await tick();
    expect(t.driver.groupPostability?.(ANNOUNCE)?.canPost).toBe(true);
  });

  it("an ordinary group switched to admin-only: blocked", async () => {
    const t = await started();
    await t.driver.listGroups();
    t.sock().emit("groups.update", [{ id: OPEN, announce: true }]);
    await tick();
    expect(t.driver.groupPostability?.(OPEN)?.canPost).toBe(false);
  });

  it("MatchTime promoted then demoted (group-participants.update)", async () => {
    const t = await started();
    await t.driver.listGroups();
    t.sock().emit("group-participants.update", { id: ANNOUNCE, author: "158055467598021@lid", action: "promote", participants: [{ id: ME_LID }] });
    await tick();
    await tick();
    expect(t.driver.groupPostability?.(ANNOUNCE)?.canPost).toBe(true);
    t.sock().emit("group-participants.update", { id: ANNOUNCE, author: "158055467598021@lid", action: "demote", participants: [{ id: ME_LID }] });
    await tick();
    await tick();
    expect(t.driver.groupPostability?.(ANNOUNCE)?.canPost).toBe(false);
  });

  it("leaving a group forgets its reading", async () => {
    const t = await started();
    await t.driver.listGroups();
    await t.driver.leaveGroup(ANNOUNCE);
    expect(t.driver.groupPostability?.(ANNOUNCE)).toBeUndefined();
  });

  it("logs no group name for a reading", async () => {
    const t = await started();
    await t.driver.listGroups();
    expect(t.logs.filter((l) => l.includes("[postability]")).join("\n")).not.toContain("A group");
  });
});
