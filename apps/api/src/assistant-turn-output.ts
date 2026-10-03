export type AssistantTurnMessage =
  | { type: "text"; text: string }
  | { type: "media"; assetId: string; caption?: string | null };

export type AssistantTurnAction = { tool: string; arguments: Record<string, unknown> };

export type ParsedAssistantTurn = {
  messages: AssistantTurnMessage[];
  actions: AssistantTurnAction[];
  handoff: boolean;
  handoffReason: string | null;
};

const allowedTools = new Set([
  "create_order",
  "create_booking",
  "create_lead",
  "create_quote_request",
  "create_support_case",
  "schedule_followup",
  "handoff_conversation",
]);

const bengaliScript = /\p{Script=Bengali}/u;
const internalEnvelopeKey = /["']messages["']\s*:[\s\S]*["']actions["']\s*:/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeFallback(languageHint: string): string {
  return bengaliScript.test(languageHint)
    ? "দুঃখিত, আপনার অনুরোধটি এখন প্রক্রিয়া করা যায়নি। অনুগ্রহ করে একটু পরে আবার চেষ্টা করুন বা আমাদের টিমের সঙ্গে যোগাযোগ করুন।"
    : "Sorry, I couldn't process that request. Please try again later or contact our team.";
}

function parseJsonCandidate(candidate: string): { parsed: boolean; value?: unknown } {
  try {
    let value: unknown = JSON.parse(candidate);
    if (typeof value === "string" && /^\s*[{[]/.test(value)) value = JSON.parse(value);
    return { parsed: true, value };
  } catch {
    return { parsed: false };
  }
}

function balancedJsonCandidates(source: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let cursor = 0; cursor < source.length; cursor++) {
    const char = source[cursor];
    if (start < 0) {
      if (char === "{") {
        start = cursor;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      candidates.push(source.slice(start, cursor + 1));
      start = -1;
    }
  }
  return candidates;
}

function jsonValues(source: string): Array<{ value: unknown }> {
  const clean = source.trim().replace(/^\uFEFF/, "");
  const values: Array<{ value: unknown }> = [];
  const whole = parseJsonCandidate(clean);
  if (whole.parsed) values.push({ value: whole.value });

  const fenced = [...clean.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim());
  for (const value of fenced) {
    const parsed = parseJsonCandidate(value);
    if (parsed.parsed) values.push({ value: parsed.value });
    for (const candidate of balancedJsonCandidates(value)) {
      const embedded = parseJsonCandidate(candidate);
      if (embedded.parsed) values.push({ value: embedded.value });
    }
  }
  for (const candidate of balancedJsonCandidates(clean)) {
    const parsed = parseJsonCandidate(candidate);
    if (parsed.parsed) values.push({ value: parsed.value });
  }
  return values;
}

function isInternalEnvelope(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Array.isArray(value.messages) && Array.isArray(value.actions);
}

export function isSerializedAssistantEnvelope(text: string): boolean {
  return jsonValues(text).some(({ value }) => isInternalEnvelope(value)) ||
    internalEnvelopeKey.test(text);
}

function normalizeMessage(value: unknown): AssistantTurnMessage | null {
  if (!isRecord(value)) return null;
  if (value.type === "text" && typeof value.text === "string" && value.text.trim()) {
    return { type: "text", text: value.text.trim().slice(0, 20_000) };
  }
  if (value.type === "media" && typeof value.assetId === "string" && value.assetId.trim()) {
    return {
      type: "media",
      assetId: value.assetId.trim(),
      ...(typeof value.caption === "string" || value.caption === null ? { caption: value.caption } : {}),
    };
  }
  return null;
}

function normalizeAction(value: unknown): AssistantTurnAction | null {
  if (!isRecord(value) || typeof value.tool !== "string" || !allowedTools.has(value.tool) || !isRecord(value.arguments)) return null;
  return { tool: value.tool, arguments: value.arguments };
}

export function protectAiOutboundMessages<T extends AssistantTurnMessage>(
  messages: T[],
  senderType: string,
  languageHint = "",
): T[] {
  if (senderType !== "AI" || !messages.some((message) => message.type === "text" && isSerializedAssistantEnvelope(message.text))) {
    return messages;
  }
  return [{ type: "text", text: safeFallback(languageHint || messages.map((message) => message.type === "text" ? message.text : "").join(" ")) } as T];
}

export function parseAssistantTurn(rawText: string, languageHint = ""): ParsedAssistantTurn {
  const source = rawText.trim();
  const payload = jsonValues(source).map(({ value }) => value).find(isInternalEnvelope);
  if (payload) {
    let messages = (payload.messages as unknown[]).map(normalizeMessage).filter((message): message is AssistantTurnMessage => message !== null);
    messages = protectAiOutboundMessages(messages, "AI", languageHint || source);
    const actions = (payload.actions as unknown[]).map(normalizeAction).filter((action): action is AssistantTurnAction => action !== null).slice(0, 5);
    return {
      messages,
      actions,
      handoff: payload.handoff === true,
      handoffReason: typeof payload.handoffReason === "string" ? payload.handoffReason.slice(0, 1000) : null,
    };
  }

  const looksStructured = isSerializedAssistantEnvelope(source) || /^\s*[{[]/.test(source) || /^\s*```(?:json)?\s*[{[]/i.test(source);
  const text = looksStructured || !source ? safeFallback(languageHint || source) : source.slice(0, 20_000);
  return {
    messages: [{ type: "text", text }],
    actions: [],
    handoff: false,
    handoffReason: null,
  };
}
