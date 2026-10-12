/**
 * A real local HTTP server that plays a HOSTILE short-link host, for
 * testing `expandShortLink` (src/lib/map-link.ts) through a real `fetch`
 * instead of an injected stub: plain Node's in
 * src/lib/__tests__/map-link-real-fetch.test.ts, and Next's patched one
 * in e2e/api/venue-short-link-real-fetch.spec.ts.
 *
 * The expander only ever requests `https://maps.app.goo.gl` and
 * `https://goo.gl/maps/...`. The tests hand it a `fetch` that sends those
 * two origins to this server (`remapShortHostsTo`) and passes every other
 * option through untouched, so `redirect: "manual"`, the abort signal and
 * the unread body are exercised for real.
 *
 * Every path it serves, and what a correct expander does with it:
 *
 *   /to-map            302 to a Google Maps link         -> the place
 *   /relative          302 to "/to-map" (same host)      -> one more hop, the place
 *   /redir             302 to this server's /followed    -> refused; /followed is NEVER requested
 *   /other-host        302 to https://evil.example/x     -> refused; nothing else requested
 *   /slow-header       no answer for 30 seconds          -> timeout
 *   /endless-page      200 and a body that never ends    -> "no redirect", at once
 *   /endless-redirect  302 to a map + an endless body    -> the place, at once
 *   /hop1              -> /hop2 -> /maps/hop3 -> a map   -> the place, in exactly 3 requests
 *   /loop1             -> /loop2 -> /loop3 -> /loop4 ... -> refused after 3 requests
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export const MAP_TARGET = "https://www.google.com/maps/place/Our+Pitch/@51.52,-0.07,17z/data=!3d51.5229437!4d-0.0757291";

export interface ShortLinkServer {
  port: number;
  /** Every path requested, in order. */
  hits: string[];
  /** Sockets the client closed while the server was still writing a body. */
  aborted: () => number;
  close: () => Promise<void>;
}

export async function startShortLinkServer(): Promise<ShortLinkServer> {
  const hits: string[] = [];
  let aborted = 0;
  const timers = new Set<NodeJS.Timeout>();

  const endless = (res: http.ServerResponse) => {
    const timer = setInterval(() => res.write("x".repeat(64 * 1024)), 5);
    timers.add(timer);
    res.on("close", () => {
      clearInterval(timer);
      timers.delete(timer);
      if (!res.writableFinished) aborted += 1;
    });
  };

  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    hits.push(path);
    const port = (server.address() as AddressInfo).port;
    const redirect = (location: string) => res.writeHead(302, { location });

    switch (path) {
      case "/to-map":
        redirect(MAP_TARGET);
        return res.end();
      case "/relative":
        redirect("/to-map");
        return res.end();
      case "/redir":
        redirect(`http://127.0.0.1:${port}/followed`);
        return res.end();
      case "/followed":
        res.writeHead(200);
        return res.end("you should never have come here");
      case "/other-host":
        redirect("https://evil.example/x");
        return res.end();
      case "/slow-header": {
        const timer = setTimeout(() => res.end(), 30_000);
        timers.add(timer);
        res.on("close", () => clearTimeout(timer));
        return;
      }
      case "/endless-page":
        res.writeHead(200, { "content-type": "text/html" });
        return endless(res);
      case "/endless-redirect":
        redirect(MAP_TARGET);
        return endless(res);
      case "/hop1":
        redirect("https://maps.app.goo.gl/hop2");
        return res.end();
      case "/hop2":
        redirect("https://goo.gl/maps/hop3");
        return res.end();
      case "/maps/hop3":
        redirect(MAP_TARGET);
        return res.end();
      default: {
        const loop = /^\/loop(\d+)$/.exec(path);
        if (loop) {
          redirect(`https://maps.app.goo.gl/loop${Number(loop[1]) + 1}`);
          return res.end();
        }
        res.writeHead(404);
        return res.end();
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    aborted: () => aborted,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearTimeout(t);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
