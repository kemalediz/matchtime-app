/**
 * The WhatsApp names the bot already knows for people just added to a
 * group (2026-09-30). The server names the new player with it, and the
 * organiser's DM says "Ali joined" instead of asking for a name.
 *
 * A group-participants event carries no names; this only reads what the
 * driver already harvested (Baileys: `contacts.ts`, never a network
 * lookup). Unknown names are simply absent: the server fills them from
 * the person's first post.
 */
import { describe, it, expect } from "vitest";
import { namesForJoiners } from "./join-names.js";

describe("namesForJoiners", () => {
  it("maps each phone to the pushname the driver knows, keyed as in phones[]", async () => {
    const contacts: Record<string, unknown> = {
      "447546111893@c.us": { pushname: "Ali Veli", name: "Ali (saved)" },
      "447700900002@c.us": { pushname: "" , name: "Colin" },
    };
    const out = await namesForJoiners(["447546111893", "447700900002", "447700900003"], async (jid) => contacts[jid]);
    expect(out).toEqual({ "447546111893": "Ali Veli", "447700900002": "Colin" });
  });

  it("drops a name that is only a number, and anything a lookup throws on", async () => {
    const out = await namesForJoiners(["1", "2"], async (jid) => {
      if (jid === "1@c.us") return { pushname: "+44 7546 111893" };
      throw new Error("no page");
    });
    expect(out).toEqual({});
  });

  it("never waits long: a lookup that hangs is skipped", async () => {
    const out = await namesForJoiners(["1"], () => new Promise(() => {}), 20);
    expect(out).toEqual({});
  });
});
