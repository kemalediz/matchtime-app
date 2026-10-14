/**
 * A graphic queued for the admin group rides on an ordinary "admin-group"
 * BotJob (2026-10-14): no schema change. Its target sits in `pollOptions`,
 * which only a "group-poll" job ever reads, behind a tag no poll option
 * could carry by accident. The URL is signed when the job is EMITTED, so
 * the Pi always gets a fresh one however long the job waited.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { graphicJobOptions, graphicUrl, readGraphicJob } from "../graphic-job";
import { verifyGraphicToken } from "../graphic-token";

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { AUTH_SECRET: process.env.AUTH_SECRET, NEXTAUTH_URL: process.env.NEXTAUTH_URL };
  process.env.AUTH_SECRET = "unit-graphic-secret";
  process.env.NEXTAUTH_URL = "https://mt.example";
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("graphicJobOptions / readGraphicJob", () => {
  it("round-trips the kind, the match and whether an admin asked for it", () => {
    expect(readGraphicJob(graphicJobOptions({ kind: "list", matchId: "m-1", asked: true }))).toEqual({ kind: "list", matchId: "m-1", asked: true });
    expect(readGraphicJob(graphicJobOptions({ kind: "teams", matchId: "m-2", asked: false }))).toEqual({ kind: "teams", matchId: "m-2", asked: false });
  });
  it("an ordinary admin-group job (no options) or a poll's options are not a graphic", () => {
    expect(readGraphicJob([])).toBeNull();
    expect(readGraphicJob(undefined)).toBeNull();
    expect(readGraphicJob(["Yes", "No"])).toBeNull();
    expect(readGraphicJob(["graphic:v1", "ratings", "m-1", "asked"])).toBeNull();
    expect(readGraphicJob(["graphic:v1", "list", "", "asked"])).toBeNull();
  });
});

describe("graphicUrl", () => {
  it("an absolute URL on the app, whose token names the org, the match and the kind", () => {
    const url = graphicUrl({ orgId: "org-1", matchId: "m-1", kind: "teams" }, 900);
    expect(url).toMatch(/^https:\/\/mt\.example\/api\/graphics\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const token = url.split("/").pop()!;
    expect(verifyGraphicToken(token)).toEqual({ orgId: "org-1", matchId: "m-1", kind: "teams" });
  });
});
