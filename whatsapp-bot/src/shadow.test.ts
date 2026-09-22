/**
 * Shadow mode has one job: make a send IMPOSSIBLE, not merely unlikely.
 *
 * Phase 5 of `MDs/baileys-migration-plan-2026-09-21.md` puts a second
 * WhatsApp number on Baileys in a throwaway group for a week. The whole
 * value of that week is that it cannot touch Sutton FC. "The caller never
 * calls send" is not a guarantee; a guard at the driver is.
 *
 * So these tests are adversarial about the guard rather than about the
 * happy path: every send member refused, every read member still working,
 * the reaction contract (never throws) preserved, and a counter that goes
 * up so a refusal is visible rather than inferred.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WaDriver } from "./driver.js";
import {
  SHADOW_ENV,
  SHADOW_SEND_MEMBERS,
  ShadowModeSendRefused,
  refuseServerWriteInShadow,
  resolveShadowMode,
  shadowBanner,
  shadowGroup,
  shadowGuard,
  shadowMode,
  shadowPreview,
  shadowStats,
  _test_resetShadow,
} from "./shadow.js";

beforeEach(() => {
  _test_resetShadow();
  delete process.env[SHADOW_ENV];
});

// ── A driver that records everything, so "did it get through?" is a fact ──

interface Spy extends WaDriver {
  calls: string[];
}

function fakeDriver(): Spy {
  const calls: string[] = [];
  const note =
    (what: string) =>
    (...args: unknown[]) => {
      calls.push(`${what}(${args.map((a) => JSON.stringify(a) ?? String(a)).join(",")})`);
      return undefined as never;
    };
  return {
    calls,
    name: "fake",
    start: async () => void note("start")(),
    close: async () => void note("close")(),
    onOpen: note("onOpen"),
    onClose: note("onClose"),
    selfId: () => {
      calls.push("selfId()");
      return "447700900000@c.us";
    },
    selfIdentities: () => {
      calls.push("selfIdentities()");
      return ["447700900000@c.us"];
    },
    selfIds: async () => {
      calls.push("selfIds()");
      return ["447700900000@c.us"];
    },
    onMessage: note("onMessage"),
    onReaction: note("onReaction"),
    onPollVote: note("onPollVote"),
    onGroupJoin: note("onGroupJoin"),
    onGroupLeave: note("onGroupLeave"),
    sendText: async (...a) => note("sendText")(...a),
    sendTextWithMentions: async (...a) => note("sendTextWithMentions")(...a),
    sendDirectText: async (...a) => note("sendDirectText")(...a),
    sendPoll: async (...a) => note("sendPoll")(...a),
    sendReaction: async (...a) => {
      note("sendReaction")(...a);
      return { ok: true } as const;
    },
    replyTo: async () => {
      calls.push("replyTo()");
    },
    sendTextViaChat: async (...a) => note("sendTextViaChat")(...a),
    listGroups: async () => {
      calls.push("listGroups()");
      return [{ id: "120363@g.us", name: "Test" }];
    },
    groupParticipants: async (...a) => {
      note("groupParticipants")(...a);
      return ["447700900001@c.us"];
    },
    groupSnapshot: async (...a) => {
      note("groupSnapshot")(...a);
      return { subject: "Test", participants: [], source: "none" as const, notes: [] };
    },
    getContact: async (...a) => note("getContact")(...a),
    contactOf: async (...a) => note("contactOf")(...a),
    fetchRecentGroupMessages: async (...a) => {
      note("fetchRecentGroupMessages")(...a);
      return [];
    },
    listDmChats: async () => {
      calls.push("listDmChats()");
      return [];
    },
  };
}

// ── The switch ──────────────────────────────────────────────────────

describe("resolveShadowMode", () => {
  it("is OFF when the variable is unset or blank, so nothing changes by default", () => {
    expect(resolveShadowMode({}).enabled).toBe(false);
    expect(resolveShadowMode({ [SHADOW_ENV]: "" }).enabled).toBe(false);
    expect(resolveShadowMode({ [SHADOW_ENV]: "   " }).enabled).toBe(false);
  });

  it("is ON for the truthy spellings an operator actually types", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
      expect(resolveShadowMode({ [SHADOW_ENV]: v }).enabled, v).toBe(true);
    }
  });

  it("is OFF for the explicit falsy spellings", () => {
    for (const v of ["0", "false", "no", "off"]) {
      expect(resolveShadowMode({ [SHADOW_ENV]: v }).enabled, v).toBe(false);
    }
  });

  it("THROWS on a typo rather than quietly leaving the guard off", () => {
    // The dangerous direction is an operator who believes shadow mode is on
    // while it is off. WA_DRIVER follows the same rule for the same reason.
    expect(() => resolveShadowMode({ [SHADOW_ENV]: "ture" })).toThrow(/WA_SHADOW/);
    expect(() => resolveShadowMode({ [SHADOW_ENV]: "shadow" })).toThrow(/not a yes or a no/);
  });

  it("names where the decision came from, for the startup log", () => {
    expect(resolveShadowMode({ [SHADOW_ENV]: "1" }).source).toContain(SHADOW_ENV);
  });
});

describe("shadowMode() reads the process env once", () => {
  it("is off by default and on once the variable is set and the cache cleared", () => {
    expect(shadowMode().enabled).toBe(false);
    process.env[SHADOW_ENV] = "1";
    _test_resetShadow();
    expect(shadowMode().enabled).toBe(true);
  });
});

// ── The guard ───────────────────────────────────────────────────────

describe("shadowGuard refuses every send path", () => {
  it("covers exactly the outbound members, no more and no fewer", () => {
    expect([...SHADOW_SEND_MEMBERS].sort()).toEqual(
      [
        "replyTo",
        "sendDirectText",
        "sendPoll",
        "sendReaction",
        "sendText",
        "sendTextViaChat",
        "sendTextWithMentions",
      ].sort(),
    );
  });

  it("throws on every send except sendReaction, and nothing reaches the driver", async () => {
    const inner = fakeDriver();
    const log: string[] = [];
    const guarded = shadowGuard(inner, { log: (l) => log.push(l) });

    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["sendText", () => guarded.sendText("120363@g.us", "squad is up")],
      [
        "sendTextWithMentions",
        () => guarded.sendTextWithMentions("120363@g.us", "@Ali you are in", ["447700900001"]),
      ],
      ["sendDirectText", () => guarded.sendDirectText("447700900001", "rate the lads")],
      ["sendPoll", () => guarded.sendPoll("120363@g.us", "MoM?", ["Ali", "Sam"], false)],
      ["replyTo", () => guarded.replyTo({} as never, "got it")],
      ["sendTextViaChat", () => guarded.sendTextViaChat("120363@g.us", "squad is up")],
    ];

    for (const [member, call] of attempts) {
      const err = await call().then(
        () => new Error("it resolved"),
        (e: unknown) => e,
      );
      expect(err, member).toBeInstanceOf(ShadowModeSendRefused);
      expect((err as ShadowModeSendRefused).member, member).toBe(member);
      expect((err as Error).message, member).toMatch(/shadow mode/i);
    }

    expect(inner.calls).toEqual([]);
  });

  it("keeps sendReaction's never-throws contract and answers with a named reason", async () => {
    const inner = fakeDriver();
    const guarded = shadowGuard(inner);
    const outcome = await guarded.sendReaction("false_120363@g.us_ABC", "✅");
    expect(outcome).toEqual({ ok: false, reason: "shadow-mode" });
    expect(inner.calls).toEqual([]);
  });

  it("logs what it WOULD have sent, so the shadow run is readable", async () => {
    const inner = fakeDriver();
    const log: string[] = [];
    const guarded = shadowGuard(inner, { log: (l) => log.push(l) });
    await guarded.sendText("120363@g.us", "Squad for Tuesday:\nAli\nSam").catch(() => {});
    await guarded.sendPoll("120363@g.us", "MoM?", ["Ali", "Sam"], true).catch(() => {});
    await guarded.sendReaction("false_120363@g.us_ABC", "✅");

    const all = log.join("\n");
    expect(all).toMatch(/\[shadow\]/);
    expect(all).toContain("120363@g.us");
    expect(all).toContain("Squad for Tuesday:");
    expect(all).toContain("MoM?");
    expect(all).toContain("Ali");
    // Newlines must not break the line into two log lines.
    expect(log.every((l) => !l.includes("\n"))).toBe(true);
  });

  it("counts every refusal, per member, so a mistake shows up as a number", async () => {
    const guarded = shadowGuard(fakeDriver(), { log: () => {} });
    await guarded.sendText("120363@g.us", "a").catch(() => {});
    await guarded.sendText("120363@g.us", "b").catch(() => {});
    await guarded.sendReaction("false_120363@g.us_ABC", "✅");
    const stats = shadowStats();
    expect(stats.byMember.sendText).toBe(2);
    expect(stats.byMember.sendReaction).toBe(1);
    expect(stats.sendsRefused).toBe(3);
  });

  it("lets every READ member through untouched, because the run is receive-only, not dead", async () => {
    const inner = fakeDriver();
    const guarded = shadowGuard(inner, { log: () => {} });
    expect(guarded.name).toBe("fake");
    expect(guarded.selfId()).toBe("447700900000@c.us");
    await guarded.selfIds();
    await guarded.listGroups();
    await guarded.groupParticipants("120363@g.us");
    await guarded.groupSnapshot("120363@g.us", []);
    await guarded.getContact("447700900001@c.us");
    await guarded.fetchRecentGroupMessages("120363@g.us", 10);
    guarded.onMessage(() => {});
    guarded.onReaction(() => {});
    await guarded.start();
    await guarded.close();
    expect(inner.calls).toContain("selfId()");
    expect(inner.calls).toContain("listGroups()");
    expect(inner.calls.some((c) => c.startsWith("fetchRecentGroupMessages"))).toBe(true);
    expect(inner.calls.some((c) => c.startsWith("onMessage"))).toBe(true);
  });
});

// ── Server writes ───────────────────────────────────────────────────

describe("refuseServerWriteInShadow", () => {
  it("does nothing at all when shadow mode is off", () => {
    expect(refuseServerWriteInShadow("https://x/api/whatsapp/bot-added", "{}")).toBe(false);
    expect(shadowStats().serverWritesRefused).toBe(0);
  });

  it("refuses and counts when shadow mode is on", () => {
    process.env[SHADOW_ENV] = "1";
    _test_resetShadow();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(refuseServerWriteInShadow("https://x/api/whatsapp/bot-added", '{"groupId":"1"}')).toBe(
      true,
    );
    expect(shadowStats().serverWritesRefused).toBe(1);
    // The route has to be in the line: "something was refused" is useless.
    expect(warn.mock.calls.flat().join(" ")).toContain("/api/whatsapp/bot-added");
    warn.mockRestore();
  });
});

describe("shadowPreview", () => {
  it("flattens newlines and truncates, so one send is one log line", () => {
    expect(shadowPreview("a\nb")).toBe("a\\nb");
    const long = shadowPreview("x".repeat(500));
    expect(long.length).toBeLessThan(200);
    expect(long).toMatch(/…$|\.\.\.$/);
  });

  it("survives anything, including a throwing getter", () => {
    const nasty = {
      get toString() {
        throw new Error("no");
      },
    };
    expect(() => shadowPreview(nasty)).not.toThrow();
  });
});

describe("shadowGroup", () => {
  it("is empty unless a real group JID is named", () => {
    expect(shadowGroup({})).toBe("");
    expect(shadowGroup({ WA_SHADOW_GROUP: "  " })).toBe("");
    // A phone, a typo or a bare number is not a group, and asking the
    // driver for a DM's history would measure nothing.
    expect(shadowGroup({ WA_SHADOW_GROUP: "447700900001@c.us" })).toBe("");
    expect(shadowGroup({ WA_SHADOW_GROUP: "120363000000000000" })).toBe("");
  });

  it("takes a group JID, trimmed", () => {
    expect(shadowGroup({ WA_SHADOW_GROUP: " 120363000000000000@g.us " })).toBe(
      "120363000000000000@g.us",
    );
  });
});

describe("shadowBanner", () => {
  it("says what is off, so the journal cannot be misread", () => {
    const banner = shadowBanner("baileys", resolveShadowMode({ [SHADOW_ENV]: "1" }));
    expect(banner).toMatch(/SHADOW MODE/);
    expect(banner).toContain("baileys");
    expect(banner).toMatch(/scheduler/i);
    expect(banner).toMatch(/flush/i);
  });
});
