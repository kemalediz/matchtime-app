/**
 * Who may add MatchTime to a group: the server-side privacy value
 * (2026-10-15). The phone's Settings showed "Everyone", yet a stranger's
 * add was refused. This reads the value the SERVER holds, once per process,
 * logs it (and only it), and sets it to "all" when it is not.
 */
import { describe, expect, it, vi } from "vitest";
import { createGroupAddPrivacyCheck, groupAddPrivacyEnabled } from "./group-add-privacy.js";

function sock(settings: Record<string, string> | Error, update?: () => Promise<void>) {
  return {
    fetchPrivacySettings: vi.fn(async (force?: boolean) => {
      void force;
      if (settings instanceof Error) throw settings;
      return settings;
    }),
    updateGroupsAddPrivacy: vi.fn(update ?? (async () => {})),
  };
}

const ALL = {
  readreceipts: "all",
  profile: "contacts",
  status: "contacts",
  online: "all",
  last: "contacts",
  groupadd: "all",
  calladd: "all",
};

function run() {
  const lines: string[] = [];
  const check = createGroupAddPrivacyCheck({ enabled: true, log: (l) => lines.push(l), error: (l) => lines.push(l) });
  return { check, lines };
}

describe("groupAddPrivacyEnabled", () => {
  it("is on unless switched off", () => {
    expect(groupAddPrivacyEnabled({})).toBe(true);
    expect(groupAddPrivacyEnabled({ MT_GROUPADD_PRIVACY_FIX: "1" })).toBe(true);
    for (const off of ["0", "false", "off", "no", " OFF "]) {
      expect(groupAddPrivacyEnabled({ MT_GROUPADD_PRIVACY_FIX: off })).toBe(false);
    }
  });
});

describe("the group-add privacy check", () => {
  it("value all: logged, nothing updated", async () => {
    const { check, lines } = run();
    const s = sock(ALL);
    await check.onOpen(s);
    expect(s.fetchPrivacySettings).toHaveBeenCalledWith(true);
    expect(s.updateGroupsAddPrivacy).not.toHaveBeenCalled();
    expect(lines).toEqual(["[baileys][privacy] groupadd=all (anyone can add MatchTime to a group)"]);
  });

  it("any other value: set to all, and the outcome logged", async () => {
    for (const value of ["contacts", "contact_blacklist", "none"]) {
      const { check, lines } = run();
      const s = sock({ ...ALL, groupadd: value });
      await check.onOpen(s);
      expect(s.updateGroupsAddPrivacy).toHaveBeenCalledWith("all");
      expect(lines[0]).toBe(`[baileys][privacy] groupadd=${value}`);
      expect(lines[1]).toBe(`[baileys][privacy] groupadd set from ${value} to all`);
    }
  });

  it("logs no other privacy value", async () => {
    const { check, lines } = run();
    await check.onOpen(sock({ ...ALL, last: "nobody-secret-marker", groupadd: "contacts" }));
    expect(lines.join("\n")).not.toContain("nobody-secret-marker");
    expect(lines.join("\n")).not.toMatch(/readreceipts|profile|status|online|last|calladd/);
  });

  it("a missing groupadd value is reported, not treated as all", async () => {
    const { check, lines } = run();
    const s = sock({ readreceipts: "all" });
    await check.onOpen(s);
    expect(lines[0]).toBe("[baileys][privacy] groupadd=(not reported)");
    expect(s.updateGroupsAddPrivacy).toHaveBeenCalledWith("all");
  });

  it("an odd value is never echoed raw", async () => {
    const { check, lines } = run();
    await check.onOpen(sock({ groupadd: "447700900961@s.whatsapp.net" }));
    expect(lines.join("\n")).not.toContain("447700900961");
  });

  it("runs once per process, not on every reconnect", async () => {
    const { check } = run();
    const a = sock(ALL);
    const b = sock(ALL);
    await check.onOpen(a);
    await check.onOpen(b);
    expect(a.fetchPrivacySettings).toHaveBeenCalledTimes(1);
    expect(b.fetchPrivacySettings).not.toHaveBeenCalled();
  });

  it("a failed read is logged and never throws; a later open tries again (at most three times)", async () => {
    const { check, lines } = run();
    const bad = sock(new Error("timed out"));
    await expect(check.onOpen(bad)).resolves.toBeUndefined();
    expect(lines[0]).toMatch(/^\[baileys\]\[privacy\] could not read the groupadd value: timed out/);
    await check.onOpen(bad);
    await check.onOpen(bad);
    await check.onOpen(bad);
    expect(bad.fetchPrivacySettings).toHaveBeenCalledTimes(3);
  });

  it("a failed update is logged and never throws", async () => {
    const { check, lines } = run();
    const s = sock({ groupadd: "contacts" }, async () => {
      throw new Error("not-authorized");
    });
    await expect(check.onOpen(s)).resolves.toBeUndefined();
    expect(lines[1]).toMatch(/could not set groupadd to all: not-authorized/);
  });

  it("a socket without the calls is logged once and skipped", async () => {
    const { check, lines } = run();
    await check.onOpen({});
    expect(lines[0]).toMatch(/cannot read privacy settings/);
  });

  it("read-only (shadow mode): reads and logs, never changes the setting", async () => {
    const lines: string[] = [];
    const check = createGroupAddPrivacyCheck({
      enabled: true,
      readOnly: true,
      log: (l) => lines.push(l),
      error: (l) => lines.push(l),
    });
    const s = sock({ groupadd: "contacts" });
    await check.onOpen(s);
    expect(s.updateGroupsAddPrivacy).not.toHaveBeenCalled();
    expect(lines).toEqual([
      "[baileys][privacy] groupadd=contacts",
      "[baileys][privacy] groupadd left at contacts: this process may not change WhatsApp settings (shadow mode)",
    ]);
  });

  it("switched off: does nothing at all", async () => {
    const lines: string[] = [];
    const check = createGroupAddPrivacyCheck({ enabled: false, log: (l) => lines.push(l), error: (l) => lines.push(l) });
    const s = sock({ groupadd: "contacts" });
    await check.onOpen(s);
    expect(s.fetchPrivacySettings).not.toHaveBeenCalled();
    expect(s.updateGroupsAddPrivacy).not.toHaveBeenCalled();
  });
});
