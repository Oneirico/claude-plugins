/**
 * Provider requests for design sparring, as plain HTTPS — no SDK.
 *
 * WHY NO SDK. An agent SDK is a tool-calling surface; one stray option and the
 * partner can search files, run code or browse. These builders return an
 * object literal with a FIXED key set, so what leaves is exactly what is
 * written here: model settings, the instructions, and the topic's own rounds.
 * `spar.test.mjs` walks every body for every provider and fails on any key
 * outside that shape.
 *
 * Keys travel in a header, never a URL: a URL lands in proxy and error logs.
 */

export const INSTRUCTIONS = [
  "You are a design sparring partner: a critic of PLANS and of the interpretation of evidence.",
  "You have no access to the codebase, tools, files or the web, and you need none. Work only from the brief.",
  "Rank the options, cut what is not needed, find the holes, and propose a better plan where you see one.",
  "Any claim of fact you make will be verified before it is used. Say when you are reasoning from general knowledge",
  "rather than from the brief, and do not invent details about the project.",
  "End your reply with one line: `VERDICT: AGREE` if you would sign the plan as it now stands, otherwise",
  "`VERDICT: CONTINUE`, followed by your remaining objections as a short list.",
].join(" ");

const OPENAI_URL = "https://api.openai.com/v1/responses";
const GEMINI_URL = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

/** @typedef {{ role: "user" | "assistant", text: string }} Turn */

function openaiRequest({ model, effort, maxOutputTokens, key }, turns) {
  return {
    url: OPENAI_URL,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: {
      model,
      instructions: INSTRUCTIONS,
      input: turns.map(({ role, text }) => ({ role, content: text })),
      reasoning: { effort },
      max_output_tokens: maxOutputTokens,
      store: false,
    },
  };
}

function geminiRequest({ model, effort, maxOutputTokens, key }, turns) {
  return {
    url: GEMINI_URL(model),
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: {
      systemInstruction: { parts: [{ text: INSTRUCTIONS }] },
      contents: turns.map(({ role, text }) => ({ role: role === "assistant" ? "model" : "user", parts: [{ text }] })),
      generationConfig: { maxOutputTokens, thinkingConfig: { thinkingLevel: effort } },
    },
  };
}

function openaiParse(json) {
  const text = (json.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text)
    .join("\n");
  const u = json.usage ?? {};
  const status = json.status === "incomplete" ? `incomplete (${json.incomplete_details?.reason ?? "unknown"})` : json.status ?? "unknown";
  return {
    text,
    status,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

function geminiParse(json) {
  const candidate = json.candidates?.[0] ?? {};
  const text = (candidate.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join("\n");
  const u = json.usageMetadata ?? {};
  const thoughts = u.thoughtsTokenCount ?? 0;
  return {
    text,
    status: candidate.finishReason === "STOP" ? "completed" : String(candidate.finishReason ?? "unknown").toLowerCase(),
    inputTokens: u.promptTokenCount ?? 0,
    // Thinking tokens bill as output, so they count toward the cost.
    outputTokens: (u.candidatesTokenCount ?? 0) + thoughts,
    reasoningTokens: thoughts,
  };
}

export const PROVIDERS = {
  openai: { build: openaiRequest, parse: openaiParse },
  gemini: { build: geminiRequest, parse: geminiParse },
};

export function providerFor(name) {
  const p = Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : null;
  if (!p) throw new Error(`unknown provider "${name}" — one of: ${Object.keys(PROVIDERS).join(", ")}`);
  return p;
}

/** The provider's error message, or the status line. Never a header. */
export function errorMessage(status, json) {
  const msg = json?.error?.message ?? (typeof json?.error === "string" ? json.error : "");
  return `HTTP ${status}${msg ? `: ${String(msg).slice(0, 500)}` : ""}`;
}

/** The partner's verdict line, if it gave one; the last one wins. */
export function verdictOf(text) {
  const all = [...text.matchAll(/VERDICT:\s*\**\s*(AGREE|CONTINUE)/gi)];
  return all.length ? all.at(-1)[1].toUpperCase() : "NONE";
}
