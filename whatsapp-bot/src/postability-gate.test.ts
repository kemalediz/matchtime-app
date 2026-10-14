/**
 * The send gate and the server report for groups MatchTime cannot post in
 * (2026-10-14). See group-postability.ts for the rule.
 */
import { describe, expect, it, vi } from "vitest";
import type { WaDriver } from "./driver.js";
import { decidePostability, type GroupPostability } from "./group-postability.js";
import { GroupNotPostableError, isGroupNotPostable, postabilityGate } from "./postability-gate.js";
import { createPostabilityReporter } from "./postability-report.js";

const GROUP = "120363000000000000@g.us";
const OTHER = "120363000000000999@g.us";

const BLOCKED = decidePostability({ announce: true, communityAnnounce: false, botIsAdmin: false });
const OPEN = decidePostability({ announce: false, communityAnnounce: false, botIsAdmin: false });

function fakeDriver(states: Record<string, GroupPostability | undefined>) {
  const calls: string[] = [];
  const d = {
    name: "fake",
    sendText: vi.fn(async (chat: string) => {
      calls.push(`text ${chat}`);
      return { id: { _serialized: "x" } };
    }),
    sendTextWithMentions: vi.fn(async (chat: string) => {
      calls.push(`mentions ${chat}`);
      return {};
    }),
    sendPoll: vi.fn(async (chat: string) => {
      calls.push(`poll ${chat}`);
      return {};
    }),
    sendDirectText: vi.fn(async (phone: string) => {
      calls.push(`dm ${phone}`);
      return {};
    }),
    replyTo: vi.fn(async (msg: { from?: string }) => {
      calls.push(`reply ${msg.from}`);
    }),
    sendTextViaChat: vi.fn(async (chat: string) => {
      calls.push(`viachat ${chat}`);
    }),
    groupPostability: (gid: string) => states[gid],
  };
  return { driver: d as unknown as WaDriver, calls, states };
}

describe("postabilityGate", () => {
  it("passes every send through in a group MatchTime can post in, and in a group it has no reading for", async () => {
    const { driver, calls } = fakeDriver({ [GROUP]: OPEN });
    const g = postabilityGate(driver, { log: () => {} });
    await g.sendText(GROUP, "hi");
    await g.sendText(OTHER, "hi");
    await g.sendPoll(GROUP, "q", ["a", "b"], false);
    expect(calls).toEqual([`text ${GROUP}`, `text ${OTHER}`, `poll ${GROUP}`]);
  });

  it("refuses every group send in a blocked group, without touching WhatsApp", async () => {
    const { driver, calls } = fakeDriver({ [GROUP]: BLOCKED });
    const logs: string[] = [];
    const g = postabilityGate(driver, { log: (l) => logs.push(l) });
    await expect(g.sendText(GROUP, "hi")).rejects.toBeInstanceOf(GroupNotPostableError);
    await expect(g.sendTextWithMentions(GROUP, "hi", [])).rejects.toThrow(/admin/);
    await expect(g.sendPoll(GROUP, "q", ["a", "b"], false)).rejects.toSatisfy(isGroupNotPostable);
    await expect(g.replyTo({ from: GROUP } as never, "hi")).rejects.toBeInstanceOf(GroupNotPostableError);
    await expect(g.sendTextViaChat(GROUP, "hi")).rejects.toBeInstanceOf(GroupNotPostableError);
    expect(calls).toEqual([]);
    // A count, never the text.
    expect(logs.at(-1)).toMatch(/5 skipped/);
    expect(logs.join("\n")).not.toMatch(/hi"/);
  });

  it("never gates a DM", async () => {
    const { driver, calls } = fakeDriver({ [GROUP]: BLOCKED });
    const g = postabilityGate(driver, { log: () => {} });
    await g.sendDirectText("447700900123", "hello");
    expect(calls).toEqual(["dm 447700900123"]);
  });

  it("resumes the moment the reading says it can post again, and logs how many were skipped", async () => {
    const { driver, calls, states } = fakeDriver({ [GROUP]: BLOCKED });
    const logs: string[] = [];
    const g = postabilityGate(driver, { log: (l) => logs.push(l) });
    await g.sendText(GROUP, "a").catch(() => {});
    await g.sendText(GROUP, "b").catch(() => {});
    states[GROUP] = OPEN;
    await g.sendText(GROUP, "c");
    expect(calls).toEqual([`text ${GROUP}`]);
    expect(logs.some((l) => /resumed/.test(l) && /2 skipped/.test(l))).toBe(true);
  });

  it("forwards every other member untouched", () => {
    const { driver } = fakeDriver({});
    const g = postabilityGate(driver, { log: () => {} });
    expect(g.name).toBe("fake");
  });
});

describe("createPostabilityReporter", () => {
  it("posts the first reading of a group and every change, not repeats", async () => {
    const post = vi.fn(async () => true);
    const r = createPostabilityReporter({ post, log: () => {} });
    await r.observe(GROUP, OPEN);
    await r.observe(GROUP, OPEN);
    await r.observe(GROUP, BLOCKED);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][0]).toEqual({
      groupId: GROUP,
      announce: true,
      communityAnnounce: false,
      botIsAdmin: false,
      canPost: false,
    });
  });

  it("a failed post is retried by flush(), and only until it lands", async () => {
    let ok = false;
    const post = vi.fn(async () => ok);
    const r = createPostabilityReporter({ post, log: () => {} });
    await r.observe(GROUP, BLOCKED);
    await r.flush();
    ok = true;
    await r.flush();
    await r.flush();
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("a throwing post is a failed post, never a throw", async () => {
    const post = vi.fn(async () => {
      throw new Error("down");
    });
    const r = createPostabilityReporter({ post, log: () => {} });
    await expect(r.observe(GROUP, BLOCKED)).resolves.toBeUndefined();
  });
});
