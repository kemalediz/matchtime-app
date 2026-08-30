/**
 * One tested sentence per capability the bot can lose when
 * whatsapp-web.js's injected page code falls out of step with the live
 * WhatsApp Web build.
 *
 * ── Why ──────────────────────────────────────────────────────────────
 * The 2026-08-28 outage was not a missing try/catch. Every broken call was
 * already caught and logged. It ran for three days because what got logged
 * was
 *
 *     [sync-participants] Sutton FC failed: r
 *
 * which names neither what stopped working nor what it costs. Reading the
 * Pi's journal, there was no way to tell that line meant "real players will
 * be blocked from putting themselves IN on the web app".
 *
 * Every entry below therefore states three things:
 *   rule        — the product behaviour this capability exists to deliver
 *   consequence — what the CUSTOMER experiences when it is gone
 *   (mitigation is shared: it is always the same version mismatch)
 *
 * Pure strings, no I/O, so the wording is pinned by tests rather than
 * drifting per call site.
 */

export type DegradedCapability =
  /** `client.getChats()` — the startup group listing, and the canary for the
   *  whole injected layer. */
  | "group-enumeration"
  /** `getChatById().participants` + `getContactById()` — the startup sweep
   *  that writes `Membership.lastSeenInGroupAt`. */
  | "participant-sync"
  /** `recoverGroupMessages` — the 2h catch-up replay after a restart. */
  | "message-recovery"
  /** The `message_reaction` event's message id — bench-prompt 👍/👎. */
  | "reaction-forwarding";

interface CapabilityInfo {
  /** The product rule this capability serves. */
  rule: string;
  /** What the customer experiences when it is unavailable. Asserted in the
   *  log line, so keep it a complete, quotable clause. */
  consequence: string;
}

export const DEGRADED_CAPABILITIES: Record<DegradedCapability, CapabilityInfo> = {
  "group-enumeration": {
    rule: "listing the WhatsApp groups this account is in, at startup",
    consequence:
      "this is the canary for the whole injected layer — contact and chat lookups are " +
      "very likely broken too, so expect degraded sender resolution and no participant sync",
  },
  "participant-sync": {
    rule: "snapshotting a group's members so the server can back-fill the roster",
    consequence:
      "Membership.lastSeenInGroupAt is not being refreshed, and it is written ONLY here — " +
      "so the web app's self-IN gate will start rejecting real players who are plainly in " +
      "the WhatsApp group, and members who joined before the bot did stay invisible",
  },
  "message-recovery": {
    rule: "replaying the last ~2h of group messages after a (re)start",
    consequence:
      "any message sent while the bot was restarting or reconnecting is lost for good — " +
      "an IN typed during a deploy will never be registered and the player will show as " +
      "missing from the roster",
  },
  "reaction-forwarding": {
    rule: "forwarding 👍/👎 reactions on a bench prompt to the server",
    consequence:
      "a benched player's 👍/👎 answer is dropped, so the bench slot is never filled and " +
      "the team turns up short",
  },
};

/** Render a cause of any shape as readable text. */
function causeText(cause: unknown): string {
  if (cause instanceof Error) return cause.message || cause.name;
  if (typeof cause === "string") return cause;
  if (cause === undefined || cause === null) return "unknown";
  try {
    return JSON.stringify(cause) ?? String(cause);
  } catch {
    return String(cause);
  }
}

/**
 * The single CRITICAL line to log when `capability` is unavailable.
 *
 * `scope` narrows it to one group/org where that is meaningful (the
 * participant sweep runs per org, so "which one" is the first question
 * anyone asks).
 */
export function degradedMessage(
  capability: DegradedCapability,
  cause: unknown,
  scope?: string,
): string {
  const info = DEGRADED_CAPABILITIES[capability];
  return (
    `CRITICAL: ${capability} is unavailable${scope ? ` for ${scope}` : ""} — ` +
    `${info.rule} is not working. Consequence: ${info.consequence}. ` +
    "Cause: whatsapp-web.js's injected page code is out of step with the live WhatsApp Web " +
    "build. Mitigation: pin a known-good build with WA_WEB_VERSION in ~/matchtime-bot/.env, " +
    `or upgrade whatsapp-web.js. See MDs/whatsapp-web-version-pinning.md. Error: ${causeText(cause)}`
  );
}
