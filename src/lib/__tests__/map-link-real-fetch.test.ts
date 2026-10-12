/**
 * `expandShortLink` through the REAL `fetch` (Node's own, the one the
 * production code calls), against a real local HTTP server playing a
 * hostile short-link host (e2e/helpers/short-link-server.ts).
 *
 * map-link.test.ts proves the rules with an injected stub. A stub cannot
 * prove that `redirect: "manual"` is honoured, that a slow host is really
 * cut off, or that an endless body is really left unread: this file does.
 * The only thing replaced is where the two short hosts resolve to
 * (`remapShortHostsTo`); every other option reaches `fetch` untouched.
 *
 * The same checks run inside the Next server, whose `fetch` is patched,
 * in e2e/api/venue-short-link-real-fetch.spec.ts.
 *
 * Loopback only. No test here reaches the internet.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAP_TARGET, startShortLinkServer, type ShortLinkServer } from "../../../e2e/helpers/short-link-server";
import { remapShortHostsTo } from "../geocode-test-seam";
import { expandShortLink, SHORT_LINK_MAX_HOPS } from "../map-link";

let server: ShortLinkServer;
let requested: string[];

const PLACE = { ok: true, target: { kind: "coords", provider: "google", lat: 51.5229437, lng: -0.0757291, label: "Our Pitch" } };

function expand(path: string, timeoutMs?: number) {
  return expandShortLink(new URL(`https://maps.app.goo.gl${path}`), {
    fetchImpl: remapShortHostsTo(server.port, fetch, requested),
    timeoutMs,
  });
}

beforeAll(async () => {
  server = await startShortLinkServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  server.hits.length = 0;
  requested = [];
});

describe("expandShortLink through the real fetch", () => {
  it("the target is not a stub's doing: the fixture really is the map link", () => {
    expect(MAP_TARGET).toContain("!3d51.5229437!4d-0.0757291");
  });

  it("a redirect to a map: one request, the place read from the Location header", async () => {
    expect(await expand("/to-map")).toEqual(PLACE);
    expect(server.hits).toEqual(["/to-map"]);
  });

  it("redirect: 'manual' HOLDS: fetch does not follow the redirect, and neither does the expander", async () => {
    const got = await expand("/redir");
    expect(got).toEqual({ ok: false, reason: "left-allow-list" });
    expect(server.hits, "/followed was never requested").toEqual(["/redir"]);
    expect(requested).toEqual(["https://maps.app.goo.gl/redir"]);
  });

  it("a hop to another host is refused and never requested", async () => {
    expect(await expand("/other-host")).toEqual({ ok: false, reason: "left-allow-list" });
    expect(requested).toEqual(["https://maps.app.goo.gl/other-host"]);
    expect(server.hits).toEqual(["/other-host"]);
  });

  it("a relative Location stays on the short host and is followed by hand", async () => {
    expect(await expand("/relative")).toEqual(PLACE);
    expect(server.hits).toEqual(["/relative", "/to-map"]);
  });

  it("a host that never sends its headers is cut off by the timeout", async () => {
    const started = Date.now();
    expect(await expand("/slow-header", 300)).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("a page with an endless body: refused at once, the body is not read, the connection is dropped", async () => {
    const started = Date.now();
    expect(await expand("/endless-page", 3000)).toEqual({ ok: false, reason: "no-redirect" });
    expect(Date.now() - started, "did not wait for the body or the timeout").toBeLessThan(1500);
    await expect.poll(() => server.aborted(), { timeout: 3000 }).toBeGreaterThanOrEqual(1);
  });

  it("a redirect with an endless body: the place at once, the body is not read", async () => {
    const before = server.aborted();
    const started = Date.now();
    expect(await expand("/endless-redirect", 3000)).toEqual(PLACE);
    expect(Date.now() - started).toBeLessThan(1500);
    await expect.poll(() => server.aborted(), { timeout: 3000 }).toBeGreaterThan(before);
  });

  it("a three hop chain across both short hosts ends at the place in exactly three requests", async () => {
    expect(SHORT_LINK_MAX_HOPS).toBe(3);
    expect(await expand("/hop1")).toEqual(PLACE);
    expect(server.hits).toEqual(["/hop1", "/hop2", "/maps/hop3"]);
    expect(requested).toEqual(["https://maps.app.goo.gl/hop1", "https://maps.app.goo.gl/hop2", "https://goo.gl/maps/hop3"]);
  });

  it("an endless chain stops after three requests", async () => {
    expect(await expand("/loop1")).toEqual({ ok: false, reason: "too-many-hops" });
    expect(server.hits).toEqual(["/loop1", "/loop2", "/loop3"]);
  });
});
