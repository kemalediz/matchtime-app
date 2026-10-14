/**
 * Telling the server whether MatchTime can post in a group (2026-10-14).
 *
 * The driver's tracker (group-postability.ts) calls back with a group's
 * first reading in this process and with every change of it. Each is
 * POSTed to /api/whatsapp/group-postability, which decides what it means:
 * a live club's group gone admin-only, an admin group MatchTime was
 * demoted in, a connect request waiting for MatchTime to be made admin.
 *
 * Only group ids and four booleans leave the Pi. A reading already
 * delivered is not sent again; one that failed is retried by `flush()`
 * (called after every /orgs refresh, every few minutes), never in a loop.
 * Never throws.
 */
import type { GroupPostability } from "./group-postability.js";

export interface PostabilityReportBody {
  groupId: string;
  announce: boolean;
  communityAnnounce: boolean;
  botIsAdmin: boolean;
  canPost: boolean;
}

export interface PostabilityReporter {
  observe(groupId: string, reading: GroupPostability): Promise<void>;
  /** Retry every reading not delivered yet. */
  flush(): Promise<void>;
}

const signature = (b: PostabilityReportBody) =>
  `${b.announce ? 1 : 0}${b.communityAnnounce ? 1 : 0}${b.botIsAdmin ? 1 : 0}${b.canPost ? 1 : 0}`;

export function createPostabilityReporter(deps: {
  /** True when the server took it. */
  post: (body: PostabilityReportBody) => Promise<boolean>;
  log?: (line: string) => void;
}): PostabilityReporter {
  const log = deps.log ?? ((l: string) => console.log(l));
  const delivered = new Map<string, string>();
  const wanted = new Map<string, PostabilityReportBody>();
  const inFlight = new Set<string>();

  async function send(groupId: string): Promise<void> {
    const body = wanted.get(groupId);
    if (!body || inFlight.has(groupId)) return;
    const sig = signature(body);
    if (delivered.get(groupId) === sig) return;
    inFlight.add(groupId);
    try {
      let ok = false;
      try {
        ok = await deps.post(body);
      } catch {
        ok = false;
      }
      if (ok) {
        delivered.set(groupId, sig);
        log(`[postability] ${groupId}: told the server canPost=${body.canPost} (admin=${body.botIsAdmin})`);
      } else {
        log(`[postability] ${groupId}: could not tell the server; retried at the next refresh`);
      }
    } finally {
      inFlight.delete(groupId);
    }
  }

  return {
    async observe(groupId, reading) {
      wanted.set(groupId, {
        groupId,
        announce: reading.announce,
        communityAnnounce: reading.communityAnnounce,
        botIsAdmin: reading.botIsAdmin,
        canPost: reading.canPost,
      });
      await send(groupId);
    },
    async flush() {
      for (const groupId of [...wanted.keys()]) await send(groupId);
    },
  };
}
