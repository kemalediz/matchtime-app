import { config } from "./config.js";
import type { HeartbeatPayload } from "./heartbeat.js";
import { refuseServerWriteInShadow } from "./shadow.js";

const headers = {
  "Content-Type": "application/json",
  "x-api-key": config.apiKey,
};

/**
 * THE ONLY PLACE THIS MODULE TOUCHES THE NETWORK.
 *
 * Every call below goes through here so that shadow mode (`shadow.ts`,
 * Phase 5 of the Baileys migration) can refuse a WRITE in one place
 * instead of in fourteen. Switching off the scheduler and the flush is not
 * enough on its own: a reaction, a poll vote, a DM reply and above all a
 * self-add are forwarded straight from their inbound handlers, and a
 * shadow number added to a throwaway group would otherwise create a real
 * onboarding session in the production database.
 *
 * A refused write returns a 200 carrying `{"shadowMode":true}`, so every
 * caller takes its ordinary "the server had nothing to say" path: no
 * CRITICAL line, no retry, no `introText` to post. Reads (GET) are left
 * alone, because knowing which orgs exist changes nothing.
 *
 * `shadow.source.test.ts` fails if a second `fetch(` appears in this file.
 */
async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && refuseServerWriteInShadow(url, init?.body)) {
    return new Response('{"shadowMode":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return fetch(url, init);
}

export async function postAttendance(
  phoneNumber: string,
  action: "IN" | "OUT",
  groupId: string,
  displayName?: string,
) {
  const res = await apiFetch(`${config.apiUrl}/api/whatsapp/attendance`, {
    method: "POST",
    headers,
    body: JSON.stringify({ phoneNumber, action, groupId, displayName }),
  });
  return res.json();
}

export async function postScore(params: {
  fromPhone: string;
  redScore: number;
  yellowScore: number;
  groupId: string;
}) {
  const res = await apiFetch(`${config.apiUrl}/api/whatsapp/score`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  return res.json();
}

export interface EnabledOrgsResponse {
  orgs?: Array<{ id?: string; name?: string | null; slug?: string; whatsappGroupId?: string | null }>;
  /** Groups mid-setup with no bot-enabled org yet (active session, not stale). */
  onboardingGroups?: string[];
}

export async function getEnabledOrgs(): Promise<EnabledOrgsResponse> {
  const res = await apiFetch(`${config.apiUrl}/api/whatsapp/orgs`, { headers });
  if (!res.ok) throw new Error(`GET /api/whatsapp/orgs → ${res.status}`);
  return (await res.json()) as EnabledOrgsResponse;
}

// ─────────────────── Scheduler endpoints (new) ───────────────────────

export type DueInstruction =
  | { kind: "group-message"; key: string; text: string; matchId?: string }
  | {
      kind: "group-poll";
      key: string;
      question: string;
      options: string[];
      multi?: boolean;
      matchId?: string;
    }
  | {
      kind: "dm";
      key: string;
      phone: string;
      text: string;
      matchId?: string;
      targetUser?: string;
    }
  | {
      kind: "bench-prompt";
      key: string;
      phone: string;
      text: string;
      matchId: string;
      userId: string;
    }
  | {
      // Retroactively swap the bot's reaction on an existing message.
      // The bot looks up the message via getMessageById and calls
      // msg.react(emoji), which replaces any prior reaction the bot
      // account placed. Used when slots shift after a drop, or when
      // historical reactions need fixing after a rule change.
      kind: "update-reaction";
      key: string;
      waMessageId: string;
      emoji: string;
    };

export async function getDuePosts(groupId: string): Promise<{
  instructions: DueInstruction[];
  waGroupId: string;
  orgId: string;
} | null> {
  const res = await apiFetch(
    `${config.apiUrl}/api/whatsapp/due-posts?groupId=${encodeURIComponent(groupId)}`,
    { headers },
  );
  if (!res.ok) {
    const body = await res.text();
    console.error("due-posts request failed:", res.status, body);
    return null;
  }
  return res.json();
}

export async function ackInstruction(ack: {
  key: string;
  kind: string;
  matchId?: string;
  targetUser?: string;
  waMessageId?: string;
  benchUserId?: string;
}): Promise<void> {
  const res = await apiFetch(`${config.apiUrl}/api/whatsapp/ack`, {
    method: "POST",
    headers,
    body: JSON.stringify(ack),
  });
  if (!res.ok) {
    console.error("ack failed:", res.status, await res.text());
  }
}

/**
 * Give a claimed instruction back to the server without sending it.
 *
 * Since 2026-07-19 the server CLAIMS an instruction (writes its dedupe
 * row) at the moment it hands it to us, so duplicate bot processes can't
 * each send the same message. That makes delivery at-most-once: anything
 * we're handed but don't send is otherwise lost forever. The DM rate
 * limiter deliberately holds DMs back expecting them to be re-emitted, so
 * it must release the claim. The server only deletes rows that carry no
 * waMessageId, i.e. that were never actually sent.
 */
export async function releaseInstruction(key: string): Promise<void> {
  const res = await apiFetch(`${config.apiUrl}/api/whatsapp/ack`, {
    method: "POST",
    headers,
    body: JSON.stringify({ key, release: true }),
  });
  if (!res.ok) {
    console.error("release failed:", res.status, await res.text());
  }
}

export async function postDmReply(params: {
  phone: string;
  body: string;
  waMessageId: string;
  authorName?: string; // pushname — server uses for @lid fallback
}): Promise<void> {
  const res = await apiFetch(`${config.apiUrl}/api/whatsapp/dm-reply`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    console.error("dm-reply post failed:", res.status, await res.text());
  }
}

export async function postReaction(params: {
  waMessageId: string;
  emoji: string;
  fromPhone: string;
  /** Reactor pushname — forwarded for @lid privacy reactors whose
   *  senderId carries no phone. Server uses it to verify the reactor
   *  is the expected bench player. Mirrors postPollVote's fallback. */
  fromAuthorName?: string;
}): Promise<void> {
  const res = await apiFetch(`${config.apiUrl}/api/whatsapp/reaction`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    console.error("reaction post failed:", res.status, await res.text());
  }
}

export async function postPollVote(params: {
  waMessageId: string;
  voterPhone: string;
  /** Optional voter pushname — useful when WhatsApp's @lid privacy hides
   *  the phone. Server uses it as a fuzzy-match fallback. */
  voterName?: string;
  optionName: string | null;
}): Promise<void> {
  const res = await apiFetch(`${config.apiUrl}/api/whatsapp/poll-vote`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    console.error("poll-vote post failed:", res.status, await res.text());
  }
}

export async function postSyncParticipants(params: {
  groupId: string;
  participants: Array<{
    phone?: string | null;
    lidId?: string | null;
    pushname?: string | null;
  }>;
}): Promise<{
  added?: number;
  alreadyKnown?: number;
  skippedNoPhone?: number;
  restoredMembership?: number;
  total?: number;
} | null> {
  const res = await apiFetch(`${config.apiUrl}/api/whatsapp/sync-participants`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    console.error("sync-participants post failed:", res.status, await res.text());
    return null;
  }
  return res.json() as Promise<{
    added?: number;
    alreadyKnown?: number;
    skippedNoPhone?: number;
    restoredMembership?: number;
    total?: number;
  }>;
}

/**
 * Phase 1 autonomous onboarding: the bot detected ITSELF being added
 * to a group. The server decides everything (ONBOARDING_AUTOSTART flag
 * gate, live-org short-circuit, session create) and returns the intro
 * text to post — or introText:null when the bot should stay silent.
 */
export async function postBotAdded(params: {
  groupId: string;
  groupSubject?: string | null;
  addedByPhone?: string | null;
  participants?: Array<{
    phone?: string | null;
    lidId?: string | null;
    pushname?: string | null;
  }>;
  /** Chat history the Pi captured shortly after join (it can only fetch
   *  WhatsApp history around join time). The server PERSISTS it on the
   *  OnboardingSession and uses it later as the enrichment fallback at
   *  completion. Oldest→newest; blank rows are dropped server-side. */
  enrichmentHistory?: Array<{
    author: string;
    authorPhone?: string | null;
    text: string;
    timestamp: string | number;
  }>;
}): Promise<{
  ok?: boolean;
  ignored?: string;
  existing?: boolean;
  introText?: string | null;
} | null> {
  const res = await apiFetch(`${config.apiUrl}/api/whatsapp/bot-added`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    console.error("bot-added post failed:", res.status, await res.text());
    return null;
  }
  return res.json() as Promise<{
    ok?: boolean;
    ignored?: string;
    existing?: boolean;
    introText?: string | null;
  }>;
}

export async function postGroupJoin(params: {
  groupId: string;
  phones: string[]; // E.164 without the leading "+"
}): Promise<void> {
  const res = await apiFetch(`${config.apiUrl}/api/whatsapp/group-join`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    console.error("group-join post failed:", res.status, await res.text());
  }
}

export async function postGroupLeave(params: {
  groupId: string;
  phones: string[];
}): Promise<void> {
  const res = await apiFetch(`${config.apiUrl}/api/whatsapp/group-leave`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    console.error("group-leave post failed:", res.status, await res.text());
  }
}

// ───────────────────── Smart-analysis endpoints ──────────────────────

export interface AnalyzeInboundMessage {
  waMessageId: string;
  body: string;
  authorPhone: string;
  authorName: string | null;
  timestamp: string; // ISO
  /** Raw WhatsApp mention JIDs (e.g. "447700900123@c.us", "…@lid"),
   *  forwarded UNCHANGED for the onboarding admin parser. */
  mentions?: string[];
  /**
   * The display name the Pi's contact lookup gave for each mentioned JID.
   * UNVERIFIED, and deliberately NOT pasted into `body` by the Pi: it is
   * the mentioned person's own WhatsApp pushname, which is often not the
   * name the club uses and is a string that person controls (2026-09-08 —
   * "@David David 67" reached the analyzer as "@割::::.̸̢̤̋…" and the drop
   * was lost). The server matches it against the org roster and only then
   * writes a name into the text. Absent from older Pi builds, and absent
   * whenever no mention had a usable name.
   */
  mentionNames?: Array<{ jid: string; name: string }>;
  /** Did this message @-mention the bot's own JID? Computed on the Pi
   *  (only it knows the bot's selfId). PRIMARY signal for the server's
   *  @Match Time interaction-contract gate; the server falls back to body
   *  text matching when this is absent (older Pi builds). */
  botMentioned?: boolean;
}

export interface AnalyzeInboundHistory {
  authorName: string | null;
  body: string;
  timestamp: string; // ISO
}

export interface AnalyzeResult {
  waMessageId: string;
  handledBy: "fast-path" | "llm" | "ignored" | "error" | "deduped";
  intent: string | null;
  react: string | null;
  reply: string | null;
  reasoning?: string;
}

export async function postAnalyze(params: {
  groupId: string;
  messages: AnalyzeInboundMessage[];
  history?: AnalyzeInboundHistory[];
}): Promise<AnalyzeResult[]> {
  const full = await postAnalyzeFull(params);
  return full.results;
}

export interface AnalyzeFullResponse {
  results: AnalyzeResult[];
  /** ms since epoch of the next upcoming match's kickoff, or null if none. */
  nextKickoffMs: number | null;
  /** Present when a setup conversation owned this batch (2026-09-17).
   *  `completed` is the Pi's cue to re-read the org list at once. */
  onboarding?: { stage: string; completed: boolean; language: string };
}

export async function postAnalyzeFull(params: {
  groupId: string;
  messages: AnalyzeInboundMessage[];
  history?: AnalyzeInboundHistory[];
}): Promise<AnalyzeFullResponse> {
  const res = await apiFetch(`${config.apiUrl}/api/whatsapp/analyze`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    // THROW. Do not return an empty result set.
    //
    // 2026-08-30 audit §4.1: this used to `console.error` and return
    // `{results: [], nextKickoffMs: null}`. `flushGroup` clears the group
    // buffer optimistically and requeues ONLY from a `catch` — a `catch`
    // that a non-throwing function can never enter. So `planFlushRetry`,
    // written specifically to stop a batch of IN/OUT messages being
    // binned, was dead code for the most likely failure of all: the
    // analyze route runs an LLM, and a 5xx or a Vercel 504 is its
    // EXPECTED failure mode, not an exotic one. A stale API key (401) did
    // the same thing. In every case the buffer was already cleared, no
    // requeue happened, nothing said CRITICAL, and the flush went on to
    // log `sent N, 0/0 actionable` as though all was well.
    //
    // Throwing hands control to the caller's existing retry path, which
    // requeues up to `MAX_FLUSH_ATTEMPTS` and then logs a CRITICAL naming
    // the message ids whose attendance is NOT recorded.
    const body = await res.text().catch(() => "");
    throw new Error(`analyze post failed: ${res.status} ${body}`.trim());
  }
  const json = (await res.json()) as {
    results?: AnalyzeResult[];
    nextKickoffMs?: number | null;
    onboarding?: { stage?: unknown; completed?: unknown; language?: unknown };
  };
  const onboarding =
    json.onboarding && typeof json.onboarding === "object"
      ? {
          stage: String(json.onboarding.stage ?? ""),
          completed: json.onboarding.completed === true,
          language: String(json.onboarding.language ?? "en"),
        }
      : undefined;
  return {
    results: json.results ?? [],
    nextKickoffMs: typeof json.nextKickoffMs === "number" ? json.nextKickoffMs : null,
    ...(onboarding ? { onboarding } : {}),
  };
}


// ─────────────────────── Heartbeat (off-Pi signal) ───────────────────

/**
 * Report this process's health to the server.
 *
 * Called from the batch-flush timer on EVERY tick, including the tick
 * where the buffer was empty. That is the whole point: the failure being
 * hunted (August 2026 — every inbound message dropped before the buffer)
 * produces nothing but empty flushes, so a report conditional on having
 * something to say would have been silent for exactly the three days it
 * was needed. It is also why this is not piggybacked on the analyze POST,
 * which only happens when there ARE messages.
 *
 * TOTAL, by design. It swallows every failure and returns `undefined`.
 *   - Wire compatibility: a NEW Pi routinely runs against an OLDER server
 *     (the server ships on merge; the Pi is deployed by hand), where this
 *     route does not exist and the call 404s. That must be a no-op.
 *   - Priority: monitoring must never be able to break the thing it
 *     monitors. A heartbeat is worth exactly zero customer messages.
 *
 * A failure is logged ONCE per process rather than every ten minutes,
 * because a line every ten minutes forever is how a log stops being read
 * — the failure this whole feature exists to fix. The server's own
 * staleness sweep is what notices the missing heartbeats anyway, and it
 * does not need the Pi's cooperation to do it.
 */
let heartbeatFailureLogged = false;

export async function postHeartbeat(payload: HeartbeatPayload): Promise<void> {
  try {
    const res = await apiFetch(`${config.apiUrl}/api/whatsapp/heartbeat`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      if (!heartbeatFailureLogged) {
        heartbeatFailureLogged = true;
        console.warn(
          `[heartbeat] the server rejected the health report (${res.status}). ` +
            "If this is a 404 the server predates the heartbeat endpoint and the Pi's " +
            "half of the health signal is simply not armed yet; the server-side " +
            "staleness sweep still runs. Not retried, and not logged again this process.",
        );
      }
      return;
    }
    // A recovered heartbeat re-arms the one-shot log, so a LATER outage
    // still gets its line.
    heartbeatFailureLogged = false;
  } catch (err) {
    if (!heartbeatFailureLogged) {
      heartbeatFailureLogged = true;
      console.warn(
        "[heartbeat] could not reach the server to report health (not logged again " +
          "this process):",
        err instanceof Error ? err.message : err,
      );
    }
  }
}
