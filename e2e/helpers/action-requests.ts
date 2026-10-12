/**
 * COUNT THE REQUESTS OF ONE SERVER ACTION, AND ONLY THAT ONE.
 *
 * Every server action a page calls is a POST to the page's own URL with a
 * `next-action` header carrying that action's id. A test that counts
 * "every POST with a `next-action` header" counts every feature on the
 * page: on /admin/settings the Go live banner's preview and the
 * learned-setup panel's reload broke each other's request counts the day
 * they met (PR #239). So a test names ITS action by what the action
 * answers, the id is learned from the first such answer, and from then on
 * only requests with that id are counted.
 *
 * Attach it BEFORE the page loads, wait for `known()` (the action has
 * answered once, so its id is known), then `reset()` and count from there.
 */
import type { Page } from "@playwright/test";

export interface ActionRequestCount {
  /** Requests of this action started since the last `reset()`. */
  count: () => number;
  /** The action has answered at least once: its id is known. */
  known: () => boolean;
  /** Count from now. */
  reset: () => void;
}

export function countRequestsOf(page: Page, answers: (body: string) => boolean): ActionRequestCount {
  const ids = new Set<string>();
  let sent: string[] = [];
  page.on("request", (req) => {
    const id = req.method() === "POST" ? req.headers()["next-action"] : undefined;
    if (id) sent.push(id);
  });
  page.on("response", async (res) => {
    const req = res.request();
    const id = req.method() === "POST" ? req.headers()["next-action"] : undefined;
    if (!id || ids.has(id)) return;
    const body = await res.text().catch(() => "");
    if (answers(body)) ids.add(id);
  });
  return {
    count: () => sent.filter((id) => ids.has(id)).length,
    known: () => ids.size > 0,
    reset: () => {
      sent = [];
    },
  };
}
