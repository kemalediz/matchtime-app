/**
 * WHO REMOVED WHOM (Kemal, 2026-10-31). The group-leave post carries the
 * remover, resolved like the adder of a bot-added event (phone, and the LID
 * it was addressed by), so the server can tell an organiser's removal from
 * a person leaving himself. The server decides; the Pi only reports.
 */
import { describe, expect, it, vi } from "vitest";
import type { WaDriver } from "./driver.js";
import { groupLeavePost } from "./group-leave.js";

const GID = "120363000000000001@g.us";
const LID = "158055467598961";
const driverWith = (getContact: (jid: string) => Promise<unknown> = async () => ({})) =>
  ({ getContact: vi.fn(getContact) }) as unknown as WaDriver;

describe("groupLeavePost", () => {
  it("an organiser removed him (phone author): the remover's phone and LID ride along", async () => {
    expect(
      await groupLeavePost(driverWith(), { chatId: GID, recipientIds: ["447700900002@c.us"], author: "447700900001@c.us", authorLid: LID }, "447700900999@c.us"),
    ).toEqual({ groupId: GID, phones: ["447700900002"], removedByPhone: "447700900001", removedByLid: LID });
  });

  it("a LID author: re-resolved to his phone locally", async () => {
    const d = driverWith(async (jid) => (jid === `${LID}@lid` ? { number: "447700900001" } : {}));
    expect(await groupLeavePost(d, { chatId: GID, recipientIds: ["447700900002@c.us"], author: `${LID}@lid` }, undefined)).toEqual({
      groupId: GID,
      phones: ["447700900002"],
      removedByPhone: "447700900001",
      removedByLid: LID,
    });
  });

  it("no author on the event: exactly today's payload, no remover fields", async () => {
    expect(await groupLeavePost(driverWith(), { chatId: GID, recipientIds: ["447700900002@c.us"] }, undefined)).toEqual({
      groupId: GID,
      phones: ["447700900002"],
    });
  });

  it("MatchTime's own id and unreadable LIDs are never forwarded as leavers; nobody left: null", async () => {
    expect(await groupLeavePost(driverWith(), { chatId: GID, recipientIds: ["447700900999@c.us", `${LID}@lid`] }, "447700900999@c.us")).toBeNull();
    expect(await groupLeavePost(driverWith(), { recipientIds: ["447700900002@c.us"] }, undefined)).toBeNull();
  });
});
