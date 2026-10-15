// Design sparring end to end against a MOCKED fetch — no test makes a real
// call. Asserted directly rather than left to review: every request body, for
// every provider, carries no tool of any kind; the budget refuses before the
// send; the guard refuses before the send; a key never reaches output.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkBudget, priceFor, worstCase, actualCost, monthToDate } from "../scripts/spar-lib/budget.mjs";
import { PROVIDERS, verdictOf } from "../scripts/spar-lib/providers.mjs";
import { main, parseCli, send } from "../scripts/spar.mjs";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "spar.mjs");
const KEY = `sk-${"k7".repeat(24)}`;
const TOPIC = "docs/sparring/2026-10-14-retry-policy";
const BASE_CONFIG = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "spar.config.json"), "utf8"));
const BRIEF = "# Brief\n\n| Option | Cost |\n|---|---|\n| A | low |\n\nAsks: rank, cut, find holes.\n";

/** Keys a request may never carry, at any depth. */
const TOOL_KEYS = /^(tools?|tool_choice|tool_config|toolConfig|tool_resources|functions?|function_call|functionDeclarations|parallel_tool_calls|include|file_search|code_interpreter|codeExecution|web_search(_preview)?|googleSearch(Retrieval)?|retrieval|attachments|mcp)$/;
const ALLOWED_BODY = {
  openai: ["model", "instructions", "input", "reasoning", "max_output_tokens", "store"],
  gemini: ["systemInstruction", "contents", "generationConfig"],
};

function keysDeep(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.push(k); keysDeep(v, out); }
  return out;
}

const REPLIES = {
  openai: { status: "completed", output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "Cut B.\nVERDICT: CONTINUE" }] }],
    usage: { input_tokens: 1000, output_tokens: 2000, output_tokens_details: { reasoning_tokens: 1500 } } },
  gemini: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "thinking", thought: true }, { text: "Fine.\nVERDICT: AGREE" }] } }],
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500, thoughtsTokenCount: 1500 } },
};

function mockFetch(provider = "openai", { status = 200, json = REPLIES[provider] } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: status < 400, status, json: async () => json };
  };
  return Object.assign(fn, { calls });
}

function fixture({ config = {}, ledger = [] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "spar-"));
  mkdirSync(path.join(root, "dev"), { recursive: true });
  mkdirSync(path.join(root, TOPIC), { recursive: true });
  mkdirSync(path.join(root, "modules/web"), { recursive: true });
  const confirmed = Object.fromEntries(Object.entries(BASE_CONFIG.providers)
    .map(([name, p]) => [name, { ...p, retentionConfirmed: "test fixture" }]));
  writeFileSync(path.join(root, "dev/spar.config.json"), JSON.stringify({ ...BASE_CONFIG, providers: confirmed, ...config }));
  writeFileSync(path.join(root, TOPIC, "round-1-brief.md"), BRIEF);
  const ledgerFile = path.join(root, ".spar/ledger.jsonl");
  if (ledger.length) {
    mkdirSync(path.dirname(ledgerFile), { recursive: true });
    writeFileSync(ledgerFile, ledger.map((e) => JSON.stringify(e)).join("\n"));
  }
  const logs = [];
  const env = { OPENAI_API_KEY: KEY, GEMINI_API_KEY: `AIza${"G".repeat(35)}` };
  return { root, ledgerFile, logs, deps: { env, root, ledgerFile, now: () => new Date("2026-10-14T12:00:00Z"), log: (l) => logs.push(l) } };
}

/* -------------------------------------------------------------- providers */

for (const provider of Object.keys(PROVIDERS)) {
  test(`${provider}: the request has a fixed shape and no tool of any kind`, () => {
    const turns = [{ role: "user", text: "b1" }, { role: "assistant", text: "r1" }, { role: "user", text: "b2" }];
    const req = PROVIDERS[provider].build({ model: "m", effort: "high", maxOutputTokens: 100, key: "KEYVALUE" }, turns);
    assert.deepEqual(Object.keys(req.body).sort(), [...ALLOWED_BODY[provider]].sort());
    assert.deepEqual(keysDeep(req.body).filter((k) => TOOL_KEYS.test(k)), []);
    assert.ok(!req.url.includes("KEYVALUE"), "the key is never in the URL");
    assert.ok(!JSON.stringify(req.body).includes("KEYVALUE"), "the key is never in the body");
  });
}

test("openai: Responses API, effort, store:false, turns in order", () => {
  const req = PROVIDERS.openai.build({ model: "gpt-6-astra", effort: "high", maxOutputTokens: 9, key: "K" },
    [{ role: "user", text: "b1" }, { role: "assistant", text: "r1" }]);
  assert.equal(req.url, "https://api.openai.com/v1/responses");
  assert.equal(req.headers.authorization, "Bearer K");
  assert.deepEqual(req.body.reasoning, { effort: "high" });
  assert.equal(req.body.store, false);
  assert.deepEqual(req.body.input, [{ role: "user", content: "b1" }, { role: "assistant", content: "r1" }]);
});

test("gemini: generateContent, key in a header, assistant turns become model", () => {
  const req = PROVIDERS.gemini.build({ model: "gemini-3.1-pro-preview", effort: "high", maxOutputTokens: 9, key: "K" },
    [{ role: "user", text: "b1" }, { role: "assistant", text: "r1" }]);
  assert.match(req.url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.1-pro-preview:generateContent$/);
  assert.equal(req.headers["x-goog-api-key"], "K");
  assert.deepEqual(req.body.contents.map((c) => c.role), ["user", "model"]);
  assert.deepEqual(req.body.generationConfig.thinkingConfig, { thinkingLevel: "high" });
});

test("responses parse to text, usage and verdict; thoughts are dropped and billed", () => {
  const o = PROVIDERS.openai.parse(REPLIES.openai);
  assert.deepEqual([o.text, o.inputTokens, o.outputTokens, o.reasoningTokens], ["Cut B.\nVERDICT: CONTINUE", 1000, 2000, 1500]);
  const g = PROVIDERS.gemini.parse(REPLIES.gemini);
  assert.deepEqual([g.text, g.outputTokens, g.status], ["Fine.\nVERDICT: AGREE", 2000, "completed"]);
  assert.equal(verdictOf(o.text), "CONTINUE");
  assert.equal(verdictOf("no verdict"), "NONE");
});

/* ----------------------------------------------------------------- budget */

test("budget: worst case, actual cost, month to date, refusal", () => {
  const price = { input: 10, output: 50 };
  assert.equal(worstCase(3000, 1000, price), 1000 * 10 / 1e6 + 1000 * 50 / 1e6);
  assert.equal(actualCost({ inputTokens: 1e6, outputTokens: 1e6 }, price), 60);
  assert.equal(monthToDate([{ at: "2026-10-01", costUsd: 2 }, { at: "2026-09-30", costUsd: 9 }], "2026-10"), 2);
  assert.throws(() => checkBudget({ spent: 49, estimate: 2, budget: 50 }), /monthly budget/);
  assert.doesNotThrow(() => checkBudget({ spent: 10, estimate: 2, budget: 50 }));
  assert.throws(() => priceFor({ prices: {} }, "gpt-x"), /no price/);
});

/* ------------------------------------------------------------ end to end */

test("send: one request, reply + sends.jsonl + ledger written, cost printed, key never printed", async () => {
  const f = fixture();
  const fetchImpl = mockFetch("openai");
  const entry = await send({ topic: TOPIC, round: "1" }, { ...f.deps, fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(entry.costUsd, Number((1000 * 10 / 1e6 + 2000 * 50 / 1e6).toFixed(6)));
  assert.match(readFileSync(path.join(f.root, TOPIC, "round-1-reply.md"), "utf8"), /Cut B\./);
  assert.equal(readFileSync(path.join(f.root, TOPIC, "sends.jsonl"), "utf8").trim().split("\n").length, 1);
  assert.ok(existsSync(f.ledgerFile));
  assert.match(f.logs.join("\n"), /cost: \$0\.1100 .* month to date \$0\.11 of \$50/);
  for (const file of [f.ledgerFile, path.join(f.root, TOPIC, "sends.jsonl")]) assert.ok(!readFileSync(file, "utf8").includes(KEY));
  assert.ok(!f.logs.join("\n").includes(KEY));
});

test("send: round 2 carries brief 1, reply 1, brief 2 and nothing else", async () => {
  const f = fixture();
  await send({ topic: TOPIC, round: "1" }, { ...f.deps, fetchImpl: mockFetch() });
  writeFileSync(path.join(f.root, TOPIC, "round-2-brief.md"), "# Round 2\nWe cut B.\n");
  const fetchImpl = mockFetch();
  await send({ topic: TOPIC, round: "2" }, { ...f.deps, fetchImpl });
  const input = fetchImpl.calls[0].body.input;
  assert.deepEqual(input.map((t) => t.role), ["user", "assistant", "user"]);
  assert.equal(input[1].content.trim(), "Cut B.\nVERDICT: CONTINUE", "the reply header is not re-sent");
});

test("send: --provider gemini switches the endpoint and the key", async () => {
  const f = fixture();
  const fetchImpl = mockFetch("gemini");
  const entry = await send({ topic: TOPIC, round: "1", provider: "gemini" }, { ...f.deps, fetchImpl });
  assert.match(fetchImpl.calls[0].url, /generativelanguage/);
  assert.equal(entry.verdict, "AGREE");
  assert.deepEqual(keysDeep(fetchImpl.calls[0].body).filter((k) => TOOL_KEYS.test(k)), []);
});

test("send: over budget is refused before any request", async () => {
  const f = fixture({ ledger: [{ at: "2026-10-02T00:00:00Z", costUsd: 49.5 }] });
  const fetchImpl = mockFetch();
  await assert.rejects(send({ topic: TOPIC, round: "1" }, { ...f.deps, fetchImpl }), /monthly budget/);
  assert.equal(fetchImpl.calls.length, 0);
});

test("send: a guarded brief is refused before any request", async () => {
  const f = fixture();
  writeFileSync(path.join(f.root, TOPIC, "round-1-brief.md"), "```ts\nexport const x = 1;\n```\n");
  const fetchImpl = mockFetch();
  await assert.rejects(send({ topic: TOPIC, round: "1" }, { ...f.deps, fetchImpl }), /outbound guard refused[\s\S]*code-block/);
  assert.equal(fetchImpl.calls.length, 0);
});

test("send: the live key pasted into a brief is refused and not echoed", async () => {
  const f = fixture();
  writeFileSync(path.join(f.root, TOPIC, "round-1-brief.md"), `We call it with ${KEY}\n`);
  await assert.rejects(send({ topic: TOPIC, round: "1" }, { ...f.deps, fetchImpl: mockFetch() }), (err) => /secret/.test(err.message) && !err.message.includes(KEY));
});

test("send: refusals for missing key, round limit, unpriced model, non-topic folder, re-send", async () => {
  const f = fixture();
  const fetchImpl = mockFetch();
  const go = (flags, deps = f.deps) => send({ topic: TOPIC, round: "1", ...flags }, { ...deps, fetchImpl });
  await assert.rejects(go({}, { ...f.deps, env: { ...f.deps.env, OPENAI_API_KEY: "" } }), /OPENAI_API_KEY is not set/);
  await assert.rejects(go({ round: "5" }), /maxRounds/);
  await assert.rejects(go({ model: "gpt-unpriced" }), /no price/);
  await assert.rejects(go({ topic: "modules/web" }), /not a topic folder/);
  assert.equal(fetchImpl.calls.length, 0);
  await go({});
  await assert.rejects(go({}), /already has a reply/);
});

test("send: a provider error reports status and message, never a header", async () => {
  const f = fixture();
  const fetchImpl = mockFetch("openai", { status: 401, json: { error: { message: "Incorrect API key provided" } } });
  await assert.rejects(send({ topic: TOPIC, round: "1" }, { ...f.deps, fetchImpl }), (err) =>
    /HTTP 401: Incorrect API key provided/.test(err.message) && !err.message.includes(KEY) && !/authorization/i.test(err.message));
  assert.ok(!existsSync(path.join(f.root, TOPIC, "round-1-reply.md")));
});

test("there is no override: --force and friends are unknown flags", async () => {
  for (const flag of ["--force", "--no-guard", "--skip-budget", "--yes"]) {
    assert.throws(() => parseCli(["send", TOPIC, "--round", "1", flag]), /Unknown option/);
  }
  await assert.rejects(main(["nonsense"], fixture().deps), /usage/);
});

test("send: refused until the owner records the provider's retention confirmation", async () => {
  const f = fixture({ config: { providers: BASE_CONFIG.providers } });
  const fetchImpl = mockFetch();
  await assert.rejects(send({ topic: TOPIC, round: "1" }, { ...f.deps, fetchImpl }), /retentionConfirmed is empty/);
  assert.equal(fetchImpl.calls.length, 0);
});

test("send: a billed response with no text is still recorded in the ledger", async () => {
  const f = fixture();
  const json = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "reasoning" }], usage: { input_tokens: 100, output_tokens: 32000 } };
  await assert.rejects(send({ topic: TOPIC, round: "1" }, { ...f.deps, fetchImpl: mockFetch("openai", { json }) }), /no text.*cost was recorded/);
  assert.equal(readFileSync(f.ledgerFile, "utf8").trim().split("\n").length, 1);
  assert.ok(!existsSync(path.join(f.root, TOPIC, "round-1-reply.md")));
});

test("check: reads only briefs under docs/sparring/, and refuses a secret without printing it", async () => {
  const f = fixture();
  writeFileSync(path.join(f.root, ".env"), "OPENAI_API_KEY=whatever\n");
  await assert.rejects(main(["check", ".env"], f.deps), /only \.md briefs under docs\/sparring/);
  await assert.rejects(main(["check", "modules/web/README.md"], f.deps), /only \.md briefs/);
  writeFileSync(path.join(f.root, TOPIC, "round-1-brief.md"), `token ${KEY}\n`);
  await assert.rejects(main(["check", `${TOPIC}/round-1-brief.md`], f.deps), (err) => /\[secret\]/.test(err.message) && !err.message.includes(KEY));
});

test("no environment seam survives in the script", () => {
  const src = ["scripts/spar.mjs", "scripts/spar-lib/budget.mjs", "scripts/spar-lib/project.mjs"]
    .map((f) => readFileSync(path.join(import.meta.dirname, "..", f), "utf8")).join("\n");
  assert.ok(!/SPAR_ROOT|SPAR_LEDGER|CLAUDE_PROJECT_DIR|process\.env\.GIT_/.test(src));
});

test("CLI: an override flag exits 1 before anything is read or sent", () => {
  let err;
  try { execFileSync(process.execPath, [SCRIPT, "send", TOPIC, "--round", "1", "--force"], { encoding: "utf8", stdio: "pipe" }); } catch (e) { err = e; }
  assert.equal(err?.status, 1);
  assert.match(err.stderr, /Unknown option '--force'/);
});
