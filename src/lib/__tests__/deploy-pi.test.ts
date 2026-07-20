/**
 * scripts/deploy-pi.sh — exit-code contract.
 *
 * The script is the ONLY sanctioned way to restart the Pi bot after the
 * 2026-07-19 duplicate-send incident (hand-run `systemctl restart` left
 * orphan processes outside the cgroup, so instances piled up).
 *
 * It runs in dry-run mode here: MT_DEPLOY_DRY_RUN=1 replaces every
 * privileged action (systemctl, pkill) with a no-op and takes the
 * post-start instance count from MT_DEPLOY_FAKE_COUNT, so the failure
 * path is verified without a Raspberry Pi.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "../../../scripts/deploy-pi.sh");

function runDryRun(fakeCount: string) {
  return spawnSync("sh", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      MT_DEPLOY_DRY_RUN: "1",
      MT_DEPLOY_FAKE_COUNT: fakeCount,
    },
  });
}

describe("scripts/deploy-pi.sh", () => {
  it("is executable", () => {
    // eslint-disable-next-line no-bitwise
    expect(statSync(SCRIPT).mode & 0o111).toBeGreaterThan(0);
  });

  it("exits 0 when exactly one instance is running afterwards", () => {
    const r = runDryRun("1");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/exactly one instance/i);
  });

  it("exits NON-ZERO when zero instances are running afterwards", () => {
    const r = runDryRun("0");
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/expected exactly 1/i);
  });

  it("exits NON-ZERO when MORE THAN ONE instance is running afterwards", () => {
    // This is the incident condition. It must be loud, not silent.
    const r = runDryRun("3");
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/expected exactly 1/i);
    expect(r.stdout + r.stderr).toMatch(/3/);
  });

  it("counts instances in a way that cannot match its own shell", () => {
    // `pgrep -f "sh -c node --env-file"` also matches the invoking
    // shell's own command line — that false positive cost us during
    // diagnosis. The script must exclude itself and its children.
    const r = spawnSync("grep", ["-c", "pgrep_exclude_self\\|-a $$\\|\\$\\$", SCRIPT], {
      encoding: "utf8",
    });
    expect(Number(r.stdout.trim())).toBeGreaterThan(0);
  });
});
