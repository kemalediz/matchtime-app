/**
 * The group snapshot without getChatModel (2026-09-17). The page
 * function runs against a fake `window.require` shaped like the
 * WhatsApp Web modules whatsapp-web.js 1.34.7 itself reaches for
 * (WAWebWidFactory, WAWebCollections.Chat, WAWebLidMigrationUtils);
 * `getChatById` throws `r` throughout, as on the live build.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Client } from "whatsapp-web.js";
import { readGroupSnapshot } from "./wwebjs-group-snapshot.js";

const asClient = (c: unknown) => c as unknown as Client;
const GID = "120363999999999999@g.us";
const SELF_PN = "447525334985@c.us";
const SELF_LID = "88813579246810@lid";

type FakeParticipant = { id: { _serialized: string }; isAdmin?: boolean; isSuperAdmin?: boolean };

/** A fake page: `evaluate(fn, arg)` runs the function here with a fake window. */
function fakePage(win: unknown) {
  return {
    evaluate: async (fn: unknown, arg: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).window = win;
      try {
        return (fn as (a: string) => unknown)(arg);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (globalThis as any).window;
      }
    },
  };
}

function fakeWindow(opts: {
  chat?: { formattedTitle?: string; name?: string; participants: FakeParticipant[]; lidToPn?: Record<string, string> };
  requireThrows?: boolean;
}) {
  const chat = opts.chat
    ? {
        id: { _serialized: GID },
        formattedTitle: opts.chat.formattedTitle,
        name: opts.chat.name,
        groupMetadata: {
          subject: opts.chat.formattedTitle ?? opts.chat.name,
          participants: { getModelsArray: () => opts.chat!.participants },
        },
      }
    : null;
  const lidToPn = opts.chat?.lidToPn ?? {};
  return {
    require: (mod: string) => {
      if (opts.requireThrows) throw new Error("r");
      switch (mod) {
        case "WAWebWidFactory":
          return { createWid: (s: string) => ({ _serialized: s }) };
        case "WAWebCollections":
          return {
            Chat: {
              get: (wid: { _serialized: string } | string) => {
                const key = typeof wid === "string" ? wid : wid._serialized;
                return key === GID ? chat : null;
              },
              getModelsArray: () => (chat ? [chat] : []),
            },
          };
        case "WAWebLidMigrationUtils":
          return {
            toPn: (wid: { _serialized: string }) => {
              const pn = lidToPn[wid._serialized];
              return pn ? { _serialized: pn } : null;
            },
          };
        default:
          throw new Error(`unknown module ${mod}`);
      }
    },
  };
}

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).window;
});

describe("readGroupSnapshot", () => {
  it("reads the subject and participants off the raw chat model, maps lids to phones, skips the bot", async () => {
    const win = fakeWindow({
      chat: {
        formattedTitle: "Cuma Halı Saha ⚽",
        participants: [
          { id: { _serialized: SELF_LID }, isSuperAdmin: true },
          { id: { _serialized: "447700900001@c.us" }, isAdmin: true },
          { id: { _serialized: "11122233344@lid" } },
          { id: { _serialized: "55566677788@lid" } },
        ],
        lidToPn: { "11122233344@lid": "447700900002@c.us" },
      },
    });
    const client = {
      pupPage: fakePage(win),
      getChatById: vi.fn(async () => {
        throw new Error("r");
      }),
      getContactById: vi.fn(async (id: string) =>
        id === "447700900001@c.us" ? { pushname: "Erdal" } : id === "55566677788@lid" ? { pushname: "Privacy Pete", number: "447700900003" } : { pushname: null },
      ),
    };
    const snap = await readGroupSnapshot(asClient(client), GID, [SELF_PN, SELF_LID]);
    expect(snap.source).toBe("page");
    expect(snap.subject).toBe("Cuma Halı Saha ⚽");
    expect(snap.participants).toEqual([
      { isAdmin: true, phone: "447700900001", pushname: "Erdal" },
      { isAdmin: false, phone: "447700900002", lidId: "11122233344@lid" },
      { isAdmin: false, lidId: "55566677788@lid", pushname: "Privacy Pete", phone: "447700900003" },
    ]);
    expect(client.getChatById).not.toHaveBeenCalled();
  });

  it("falls back to getChatById when the page cannot find the chat, and says so", async () => {
    const win = fakeWindow({ chat: undefined });
    const client = {
      pupPage: fakePage(win),
      getChatById: vi.fn(async () => ({ name: "Fallback FC", participants: [{ id: { _serialized: "447700900009@c.us" } }] })),
      getContactById: vi.fn(async () => {
        throw new Error("r");
      }),
    };
    const snap = await readGroupSnapshot(asClient(client), GID, [SELF_PN]);
    expect(snap.source).toBe("getChatById");
    expect(snap.subject).toBe("Fallback FC");
    expect(snap.participants).toEqual([{ isAdmin: false, phone: "447700900009" }]);
    expect(snap.notes.join(" ")).toContain("not in the page's Chat collection");
  });

  it("degrades to nothing, with both reasons named, when the page and the library both throw", async () => {
    const win = fakeWindow({ requireThrows: true });
    const client = {
      pupPage: fakePage(win),
      getChatById: vi.fn(async () => {
        throw new Error("r");
      }),
      getContactById: vi.fn(),
    };
    const snap = await readGroupSnapshot(asClient(client), GID, [SELF_PN]);
    expect(snap.source).toBe("none");
    expect(snap.subject).toBeNull();
    expect(snap.participants).toEqual([]);
    expect(snap.notes.join(" | ")).toMatch(/page read: r/);
    expect(snap.notes.join(" | ")).toMatch(/getChatById threw: r/);
    expect(snap.notes.join(" | ")).toMatch(/provisioned on their first message/);
  });

  it("a client with no page at all still tries the library path", async () => {
    const client = {
      getChatById: vi.fn(async () => ({ name: "No Page FC", participants: [] })),
      getContactById: vi.fn(),
    };
    const snap = await readGroupSnapshot(asClient(client), GID, []);
    expect(snap.source).toBe("getChatById");
    expect(snap.subject).toBe("No Page FC");
  });
});
