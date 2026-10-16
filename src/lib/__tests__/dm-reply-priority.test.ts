/**
 * Conversational replies before bulk sends (FNF, 2026-10-16). Pure rules.
 *
 * The real case: at 22:39 the fee release queued 16 pay-link DMs; at 22:46
 * Akram DMed "I've transferred already" and his "Thanks Akram, I've told
 * Raihan..." waited about ten minutes behind the remaining pay links,
 * because the Pi sends one DM a minute and takes the FIRST DM in the
 * server's list. These rules put the reply first, only while
 * DM_REPLY_PRIORITY_ENABLED is on.
 */
import { describe, it, expect } from "vitest";
import {
  BOTJOB_PRIORITY_DEFAULT,
  BOTJOB_PRIORITY_REPLY,
  DM_REPLY_PRIORITY_TEST_HEADER,
  REPLY_PRIORITY,
  dmReplyPriorityEnabledForApiRequest,
  isDmReplyPriorityEnabled,
  mergeBotJobBatches,
  prioritiseReplyDms,
} from "@/lib/dm-reply-priority";

type I = { kind: string; key: string; phone?: string; text?: string };
const dm = (key: string, phone: string): I => ({ kind: "dm", key, phone, text: key });
const group = (key: string): I => ({ kind: "group-message", key, text: key });

describe("the flag", () => {
  it("is OFF unless explicitly on", () => {
    expect(isDmReplyPriorityEnabled({})).toBe(false);
    expect(isDmReplyPriorityEnabled({ DM_REPLY_PRIORITY_ENABLED: "" })).toBe(false);
    expect(isDmReplyPriorityEnabled({ DM_REPLY_PRIORITY_ENABLED: "0" })).toBe(false);
    expect(isDmReplyPriorityEnabled({ DM_REPLY_PRIORITY_ENABLED: "false" })).toBe(false);
    expect(isDmReplyPriorityEnabled({ DM_REPLY_PRIORITY_ENABLED: "off" })).toBe(false);
    for (const v of ["1", "true", "on", "yes", " TRUE "]) {
      expect(isDmReplyPriorityEnabled({ DM_REPLY_PRIORITY_ENABLED: v })).toBe(true);
    }
  });

  it("the test header is honoured only when MT_TEST_MODE is exactly 1", () => {
    const req = (v: string) => new Request("http://x/", { headers: { [DM_REPLY_PRIORITY_TEST_HEADER]: v } });
    expect(dmReplyPriorityEnabledForApiRequest(req("1"), {})).toBe(false);
    expect(dmReplyPriorityEnabledForApiRequest(req("1"), { MT_TEST_MODE: "1" })).toBe(true);
    expect(dmReplyPriorityEnabledForApiRequest(req("0"), { MT_TEST_MODE: "1", DM_REPLY_PRIORITY_ENABLED: "1" })).toBe(false);
    expect(dmReplyPriorityEnabledForApiRequest(req("0"), { DM_REPLY_PRIORITY_ENABLED: "1" })).toBe(true);
    expect(dmReplyPriorityEnabledForApiRequest(new Request("http://x/"), { DM_REPLY_PRIORITY_ENABLED: "1" })).toBe(true);
  });

  it("a reply is marked with priority 1, everything else stays 0", () => {
    expect(BOTJOB_PRIORITY_DEFAULT).toBe(0);
    expect(BOTJOB_PRIORITY_REPLY).toBe(1);
    expect(REPLY_PRIORITY).toEqual({ priority: 1 });
  });
});

describe("prioritiseReplyDms", () => {
  const payLinks = Array.from({ length: 16 }, (_, i) => dm(`botjob-pay${i}`, `4477000000${String(i).padStart(2, "0")}`));

  it("puts the reply in the FIRST DM slot, ahead of 16 pay links", () => {
    const reply = dm("botjob-reply", "447700999999");
    const out = prioritiseReplyDms([...payLinks, reply], new Set(["botjob-reply"]));
    expect(out[0]).toBe(reply);
    expect(out.slice(1)).toEqual(payLinks);
  });

  it("with no reply key the list is returned untouched (same array)", () => {
    const list = [...payLinks, group("g1")];
    expect(prioritiseReplyDms(list, new Set())).toBe(list);
    expect(prioritiseReplyDms(list, new Set(["not-in-the-list"]))).toBe(list);
  });

  it("only DMs move: every non-DM keeps its index", () => {
    const g0 = group("g0");
    const g1 = group("g1");
    const reply = dm("botjob-reply", "447700999999");
    const list = [g0, payLinks[0], payLinks[1], g1, reply];
    const out = prioritiseReplyDms(list, new Set([reply.key]));
    expect(out.map((i) => i.key)).toEqual(["g0", "botjob-reply", "botjob-pay0", "g1", "botjob-pay1"]);
    expect(out).toHaveLength(list.length);
  });

  it("per recipient: a reply never overtakes an earlier DM to the SAME phone", () => {
    const akramPayLink = dm("botjob-pay-akram", "447700555555");
    const reply = dm("botjob-reply-akram", "447700555555");
    const list = [payLinks[0], payLinks[1], akramPayLink, payLinks[2], reply];
    const out = prioritiseReplyDms(list, new Set([reply.key]));
    expect(out.map((i) => i.key)).toEqual([
      "botjob-pay-akram",
      "botjob-reply-akram",
      "botjob-pay0",
      "botjob-pay1",
      "botjob-pay2",
    ]);
  });

  it("per recipient: a later bulk DM to the replying phone stays after the reply", () => {
    const reply = dm("botjob-reply", "447700555555");
    const laterBulk = dm("botjob-later", "447700555555");
    const out = prioritiseReplyDms([payLinks[0], reply, laterBulk], new Set([reply.key]));
    expect(out.map((i) => i.key)).toEqual(["botjob-reply", "botjob-pay0", "botjob-later"]);
  });

  it("phones match with or without the leading +", () => {
    const earlier = dm("chase-1", "+447700555555");
    const reply = dm("botjob-reply", "447700555555");
    const out = prioritiseReplyDms([payLinks[0], earlier, reply], new Set([reply.key]));
    expect(out.map((i) => i.key)).toEqual(["chase-1", "botjob-reply", "botjob-pay0"]);
  });

  it("two replies keep their own order, both ahead of the bulk", () => {
    const r1 = dm("botjob-r1", "447700111111");
    const r2 = dm("botjob-r2", "447700222222");
    const out = prioritiseReplyDms([payLinks[0], r1, payLinks[1], r2], new Set([r1.key, r2.key]));
    expect(out.map((i) => i.key)).toEqual(["botjob-r1", "botjob-r2", "botjob-pay0", "botjob-pay1"]);
  });

  it("never adds or drops an instruction", () => {
    const reply = dm("botjob-reply", "447700999999");
    const list = [group("g"), ...payLinks, reply, group("h")];
    const out = prioritiseReplyDms(list, new Set([reply.key]));
    expect([...out].map((i) => i.key).sort()).toEqual([...list].map((i) => i.key).sort());
  });
});

describe("mergeBotJobBatches", () => {
  const job = (id: string, ms: number) => ({ id, createdAt: new Date(ms) });

  it("dedupes by id and orders by createdAt, oldest first", () => {
    const a = [job("a", 1), job("b", 2), job("c", 3)];
    const b = [job("r", 10), job("b", 2)];
    const c = [job("old", 0)];
    expect(mergeBotJobBatches(a, b, c).map((j) => j.id)).toEqual(["old", "a", "b", "c", "r"]);
  });

  it("ties keep the order in which they were first seen", () => {
    const a = [job("x", 5), job("y", 5)];
    const b = [job("z", 5)];
    expect(mergeBotJobBatches(a, b).map((j) => j.id)).toEqual(["x", "y", "z"]);
  });
});
