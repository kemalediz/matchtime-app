/**
 * Unit tests for the bot's single-instance startup guard.
 *
 * Background (2026-07-19): repeated `systemctl restart` on the Pi left bot
 * processes running OUTSIDE systemd's cgroup, so instances accumulated.
 * Every one of them was logged into the same WhatsApp account and every
 * one polled /api/whatsapp/due-posts — hence duplicate group posts.
 *
 * The decision function is kept pure so the "is another instance alive?"
 * matrix is testable without spawning processes.
 */
import { describe, it, expect } from "vitest";
import {
  decideLockAction,
  lockExitCode,
} from "../../../whatsapp-bot/src/instance-lock";

describe("decideLockAction", () => {
  it("acquires when no lockfile exists", () => {
    expect(decideLockAction({ existing: null, selfPid: 100, isAlive: () => true })).toEqual({
      action: "acquire",
    });
  });

  it("aborts when the lockfile holds a DIFFERENT, live pid", () => {
    expect(
      decideLockAction({ existing: { pid: 42 }, selfPid: 100, isAlive: (p) => p === 42 }),
    ).toEqual({ action: "abort", holderPid: 42 });
  });

  it("steals a stale lock whose pid is dead (the usual reboot/SIGKILL case)", () => {
    expect(
      decideLockAction({ existing: { pid: 42 }, selfPid: 100, isAlive: () => false }),
    ).toEqual({ action: "steal-stale", holderPid: 42 });
  });

  it("steals a corrupt/unparseable lockfile rather than deadlocking forever", () => {
    expect(
      decideLockAction({ existing: { pid: NaN }, selfPid: 100, isAlive: () => true }),
    ).toEqual({ action: "steal-stale", holderPid: NaN });
    expect(
      decideLockAction({ existing: { pid: 0 }, selfPid: 100, isAlive: () => true }),
    ).toEqual({ action: "steal-stale", holderPid: 0 });
  });

  it("re-acquires when the lockfile somehow holds our OWN pid", () => {
    expect(
      decideLockAction({ existing: { pid: 100 }, selfPid: 100, isAlive: () => true }),
    ).toEqual({ action: "acquire" });
  });
});

describe("lockExitCode — must not create a systemd crash-restart loop", () => {
  it("exits 0 under systemd (Restart=on-failure ignores a clean exit)", () => {
    // systemd sets INVOCATION_ID for every unit it starts. A non-zero exit
    // here would make Restart=on-failure respawn us instantly, forever,
    // for as long as the other instance lives.
    expect(lockExitCode({ underSystemd: true })).toBe(0);
  });

  it("exits non-zero when run by hand, so a human sees the failure loudly", () => {
    expect(lockExitCode({ underSystemd: false })).toBe(1);
  });
});
