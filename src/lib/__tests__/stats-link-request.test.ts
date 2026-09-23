/**
 * THE PERSONAL STATS LINK GOES TO THE ASKER, AND ONLY TO THE ASKER
 * (2026-09-17).
 *
 * `sendOwnStatsLink` is the action the deleted `STATS_REQUEST` fast path
 * performed, lifted out of `analyze/route.ts` with its I/O injected. The
 * model now decides WHETHER (`QuestionTopic.my_stats`); these tests pin
 * WHO: the recipient is read from the resolved sender of the message and
 * from nothing else, so no extracted fact can point the DM elsewhere.
 */
import { describe, it, expect } from "vitest";
import { sendOwnStatsLink } from "../stats-link-request";
import { buildStatsLinkDm } from "../dm-copy";
import { buildStatsLinkSentLine } from "../group-copy";

function recorder() {
  const dms: Array<{ phone: string; text: string }> = [];
  const links: string[] = [];
  return {
    dms,
    links,
    deps: {
      linkFor: async (userId: string) => {
        links.push(userId);
        return `https://mt.test/l/${userId}`;
      },
      queueDm: async (dm: { phone: string; text: string }) => {
        dms.push(dm);
      },
    },
  };
}

describe("sendOwnStatsLink", () => {
  it("queues exactly ONE DM, to the sender's phone, with the sender's own link", async () => {
    const r = recorder();
    const out = await sendOwnStatsLink({
      sender: { userId: "u-pete", name: "Pete Power", phone: "+447700900003" },
      authorPhone: "447700900003",
      lang: "en",
      deps: r.deps,
    });
    expect(out.queued).toBe(true);
    expect(r.dms).toEqual([
      {
        phone: "447700900003",
        text: buildStatsLinkDm({ name: "Pete Power", url: "https://mt.test/l/u-pete", lang: "en" }),
      },
    ]);
    expect(r.links).toEqual(["u-pete"]);
  });

  it("falls back to the message's author phone when the user row has none (the old rule)", async () => {
    const r = recorder();
    await sendOwnStatsLink({
      sender: { userId: "u-pete", name: "Pete Power", phone: null },
      authorPhone: "+447700900003",
      lang: "en",
      deps: r.deps,
    });
    expect(r.dms.map((d) => d.phone)).toEqual(["447700900003"]);
  });

  it("writes the DM in the org's language", async () => {
    const r = recorder();
    await sendOwnStatsLink({
      sender: { userId: "u-m", name: "Mehmet Yılmaz", phone: "905551112233" },
      authorPhone: "905551112233",
      lang: "tr",
      deps: r.deps,
    });
    expect(r.dms[0].text).toBe(buildStatsLinkDm({ name: "Mehmet Yılmaz", url: "https://mt.test/l/u-m", lang: "tr" }));
  });

  it("sends nothing for an unresolved sender or a sender with no phone at all", async () => {
    for (const sender of [
      { userId: null, name: "Someone", phone: "447700900009" },
      { userId: "u-x", name: "No Phone", phone: null },
    ]) {
      const r = recorder();
      const out = await sendOwnStatsLink({ sender, authorPhone: null, lang: "en", deps: r.deps });
      expect(out.queued).toBe(false);
      expect(r.dms).toEqual([]);
      expect(r.links).toEqual([]);
    }
  });

  it("a queue failure is reported, not thrown", async () => {
    const out = await sendOwnStatsLink({
      sender: { userId: "u-pete", name: "Pete", phone: "447700900003" },
      authorPhone: null,
      lang: "en",
      deps: {
        linkFor: async () => "https://mt.test/l",
        queueDm: async () => {
          throw new Error("db down");
        },
      },
    });
    expect(out.queued).toBe(false);
    expect(out.reason).toMatch(/db down/);
  });

  // 2026-09-23: the group hears a line, addressed to the asker, saying the
  // stats are coming by DM (it used to see only a 📊 react). The line is
  // returned only when the DM was actually queued, so the group is never
  // told "I'm sending" about a DM that was never going to go.
  it("returns the group line for a queued DM, in the org's language, addressed to the asker", async () => {
    for (const lang of ["en", "tr"] as const) {
      const r = recorder();
      const out = await sendOwnStatsLink({
        sender: { userId: "u-erdal", name: "Erdal Yilmaz", phone: "905551112233" },
        authorPhone: null,
        lang,
        deps: r.deps,
      });
      expect(out.queued).toBe(true);
      expect(out.groupLine).toBe(buildStatsLinkSentLine({ name: "Erdal Yilmaz", lang }));
    }
  });

  it("returns NO group line when nothing was queued", async () => {
    const cases = [
      { sender: { userId: null, name: "Someone", phone: "447700900009" }, deps: recorder().deps },
      { sender: { userId: "u-x", name: "No Phone", phone: null }, deps: recorder().deps },
      {
        sender: { userId: "u-pete", name: "Pete", phone: "447700900003" },
        deps: {
          linkFor: async () => "https://mt.test/l",
          queueDm: async () => {
            throw new Error("db down");
          },
        },
      },
    ];
    for (const c of cases) {
      const out = await sendOwnStatsLink({ sender: c.sender, authorPhone: null, lang: "en", deps: c.deps });
      expect(out.queued).toBe(false);
      expect(out.groupLine).toBeNull();
    }
  });
});
