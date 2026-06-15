import { config } from "./config.js";

const headers = {
  "Content-Type": "application/json",
  "x-api-key": config.apiKey,
};

export async function postAttendance(
  phoneNumber: string,
  action: "IN" | "OUT",
  groupId: string,
  displayName?: string,
) {
  const res = await fetch(`${config.apiUrl}/api/whatsapp/attendance`, {
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
  const res = await fetch(`${config.apiUrl}/api/whatsapp/score`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  return res.json();
}

export async function getEnabledOrgs() {
  const res = await fetch(`${config.apiUrl}/api/whatsapp/orgs`, { headers });
  return res.json();
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
  const res = await fetch(
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
  const res = await fetch(`${config.apiUrl}/api/whatsapp/ack`, {
    method: "POST",
    headers,
    body: JSON.stringify(ack),
  });
  if (!res.ok) {
    console.error("ack failed:", res.status, await res.text());
  }
}

export async function postDmReply(params: {
  phone: string;
  body: string;
  waMessageId: string;
  authorName?: string; // pushname — server uses for @lid fallback
}): Promise<void> {
  const res = await fetch(`${config.apiUrl}/api/whatsapp/dm-reply`, {
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
  const res = await fetch(`${config.apiUrl}/api/whatsapp/reaction`, {
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
  const res = await fetch(`${config.apiUrl}/api/whatsapp/poll-vote`, {
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
  const res = await fetch(`${config.apiUrl}/api/whatsapp/sync-participants`, {
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
}): Promise<{
  ok?: boolean;
  ignored?: string;
  existing?: boolean;
  introText?: string | null;
} | null> {
  const res = await fetch(`${config.apiUrl}/api/whatsapp/bot-added`, {
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
  const res = await fetch(`${config.apiUrl}/api/whatsapp/group-join`, {
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
  const res = await fetch(`${config.apiUrl}/api/whatsapp/group-leave`, {
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
}

export async function postAnalyzeFull(params: {
  groupId: string;
  messages: AnalyzeInboundMessage[];
  history?: AnalyzeInboundHistory[];
}): Promise<AnalyzeFullResponse> {
  const res = await fetch(`${config.apiUrl}/api/whatsapp/analyze`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    console.error("analyze post failed:", res.status, await res.text());
    return { results: [], nextKickoffMs: null };
  }
  const json = (await res.json()) as {
    results?: AnalyzeResult[];
    nextKickoffMs?: number | null;
  };
  return {
    results: json.results ?? [],
    nextKickoffMs: typeof json.nextKickoffMs === "number" ? json.nextKickoffMs : null,
  };
}

