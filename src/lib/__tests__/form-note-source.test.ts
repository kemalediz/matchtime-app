/**
 * A FORM NOTE REMEMBERS WHICH MESSAGE WROTE ITS REASON (2026-11-16, PR #606
 * round 9). A later message that only changes the amount moves
 * `sourceMessageId` on, but the reason ("tired") is still the earlier
 * message's words: `reasonSourceMessageId` keeps that message, so a delete
 * or an edit of EITHER purges the reason (`message-change.ts`). Made-up
 * people; an in-memory table.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeDb, type Row } from "./fake-message-db";

const T: Record<string, Row[]> = {};
const fake = makeDb(T, ["formNote"], { formNote: [["matchId", "userId"]] });
vi.mock("@/lib/db", () => ({
  get db() {
    return fake.db;
  },
}));
vi.mock("../db", () => ({
  get db() {
    return fake.db;
  },
}));

import { prismaFormNoteStore } from "../form-note";

const note = (over: Record<string, unknown>) => ({ orgId: "org-a", matchId: "m1", userId: "u-sam", delta: -1, reason: "", setByUserId: "u-sam", sourceMessageId: null as string | null, ...over });

beforeEach(() => {
  T.formNote = [];
});

describe("prismaFormNoteStore", () => {
  it("the message that wrote the reason stays its source when a later message only changes the amount", async () => {
    await prismaFormNoteStore.save(note({ reason: "tired", sourceMessageId: "msg-A" }));
    expect(T.formNote[0]).toMatchObject({ reason: "tired", sourceMessageId: "msg-A", reasonSourceMessageId: "msg-A" });
    await prismaFormNoteStore.save(note({ delta: -2, reason: "", sourceMessageId: "msg-B" }));
    expect(T.formNote[0]).toMatchObject({ delta: -2, reason: "tired", sourceMessageId: "msg-B", reasonSourceMessageId: "msg-A" });
    // A new reason moves it on.
    await prismaFormNoteStore.save(note({ delta: -1, reason: "knee", sourceMessageId: "msg-C" }));
    expect(T.formNote[0]).toMatchObject({ reason: "knee", sourceMessageId: "msg-C", reasonSourceMessageId: "msg-C" });
  });

  it("a note with no reason has no reason source", async () => {
    await prismaFormNoteStore.save(note({ reason: "", sourceMessageId: "msg-D" }));
    expect(T.formNote[0]).toMatchObject({ reason: "", sourceMessageId: "msg-D", reasonSourceMessageId: null });
  });
});
