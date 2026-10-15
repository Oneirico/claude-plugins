// #24: the outbound guard's residual gaps from #22's Security Officer review
// (L1 code detection, L2 personal and host data) and Nilometer's port review
// (symlinks, extra key variables, hook spelling). Each gap is a test, and so is
// the prose that must still pass — a guard that refuses ordinary briefs gets
// worked around, which is worse than one that misses a little.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkOutbound, formatRefusal, indexCodeLines } from "../scripts/spar-lib/guard.mjs";
import { main, send } from "../scripts/spar.mjs";

const BASE_CONFIG = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "spar.config.json"), "utf8"));
const EMPTY = { guard: { maxBriefChars: 1e5, maxRequestChars: 1e6, codePaths: [], sealed: [], deny: [] } };
const TOPIC = "docs/sparring/2026-10-14-hardening";

const rules = (text, extra, config = EMPTY) =>
  checkOutbound([{ name: "round-1-brief.md", text }], config, extra).map((r) => r.rule);
const refuses = (text, rule, extra) => assert.ok(rules(text, extra).includes(rule), `expected ${rule} for:\n${text}\ngot ${rules(text, extra)}`);
const passes = (text, extra) => assert.deepEqual(rules(text, extra), [], `expected a pass for:\n${text}`);

/* ------------------------------------------------------- L1: code detection */

test("braced and attributed fence tags are read as their language", () => {
  for (const tag of ["{python}", "{.python}", "python {.numberLines}", "{.js .numberLines}"]) {
    refuses(`Idea:\n\`\`\`${tag}\nx = 1\n\`\`\`\n`, "code-block");
  }
});

test("untagged or text fences holding SQL, shell or YAML are refused", () => {
  refuses("```\nSELECT id, name FROM users\nWHERE active = 1\n```", "code-block");
  refuses("```text\nINSERT INTO runs (id) VALUES (1)\nUPDATE runs SET ok = 1\n```", "code-block");
  refuses("```\n$ npm run build\n$ git push origin main\n```", "code-block");
  refuses("```\ncurl -s https://x | jq .items\ndocker compose up -d && sleep 5\n```", "code-block");
  refuses("```\nservices:\n  api:\n    image: app:latest\n    ports:\n      - 8080\n```", "code-block");
});

test("a one-line code block is refused", () => {
  refuses("```\nretry(fetchBatch(cursor), { attempts: 3 })\n```", "code-block");
  refuses("```\nprint(compute_window(cfg))\n```", "code-block");
});

test("unfenced Python and SQL are refused", () => {
  refuses("The rule:\ndef window(retries):\n    return retries * 1.5\n", "code-block");
  refuses("Query:\nSELECT count(*) FROM runs\nWHERE failed = true\n", "code-block");
});

test("prose, tables, notes and plain-English verbs still pass", () => {
  passes(`# Brief

We select the cheaper option, update the plan weekly, and return to it in Q3.
If retries fail: stop, log, and alert.

| Option | Retries | Cost |
|--------|---------|------|
| A | 3 | low |

- Step one: diagnose before fixing.
- Step two: a 60% hard stop.

\`\`\`text
night 1: fail
night 2: ok
\`\`\`

> Note: the class of failures is mostly timeouts.

These pass today:
  - untagged fences;
  - one-line blocks;
  - braced tags;
  - unfenced snippets.
`);
});

/* ------------------------------------------- #24 review: M2, L1, L2, L3 */

test("a mermaid fence is no hiding place for code, braced or not, and a diagram still passes", () => {
  refuses("```{.mermaid}\nconst a = 1;\nconst b = 2;\n```", "code-block");
  refuses("```mermaid\nflowchart LR\nimport os\n```", "code-block");
  passes("```mermaid\nflowchart LR\n  A ==> B;\n  B -->|no| A;\n```");
});

test("a source-tagged fence line inside an open fence neither closes it nor hides what follows", () => {
  refuses("```\nnote\n```python\nx = os.environ['K']\nsecret = x\nprint(secret)\n```", "code-block");
});

test("file names and package versions are not personal or host data", () => {
  passes("Copy .env.local into the worktree; keep .claude/settings.local.json personal.");
  passes("We pin lodash@4.17.21 and @openspec/cli@1.2.0; staging.local.yml is a file name.");
});

test("size is refused first, and a pathological line is refused fast and unread", () => {
  const huge = "a.".repeat(15000);
  const t = Date.now();
  const out = checkOutbound([{ name: "b.md", text: huge }], { guard: { ...EMPTY.guard, maxBriefChars: 1e6 } });
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t}ms`);
  assert.deepEqual(out.map((r) => r.rule), ["size"]);
});

/* ------------------------------------------------ L1: copied code, floors */

function codeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "spar-harden-"));
  mkdirSync(path.join(root, "modules/web"), { recursive: true });
  mkdirSync(path.join(root, "dev/scripts"), { recursive: true });
  writeFileSync(path.join(root, "modules/web/retry.ts"), "  const retries = config.retries ?? 3;\n");
  writeFileSync(path.join(root, "dev/scripts/tool.mjs"), "const budgetWindow = monthlyBudget / daysInMonth;\n");
  writeFileSync(path.join(root, "build.mjs"), "await bundle({ entry: 'src/main.ts', minify: true });\n");
  return root;
}

test("a reformatted copy of a code line is refused: list item, doubled spaces, no semicolon, backticks", () => {
  const codeLines = indexCodeLines(codeRoot(), ["modules"]);
  refuses("- const  retries = config.retries ?? 3\n", "code-file", { codeLines });
  refuses("> const retries = config.retries ?? 3;\n", "code-file", { codeLines });
  refuses("We read `const retries = config.retries ?? 3` at start.\n", "code-file", { codeLines });
  passes("Retries default to three when the config is silent.\n", { codeLines });
});

test("code paths have a floor the config cannot lower: dev/ and root code files are always indexed", () => {
  const codeLines = indexCodeLines(codeRoot(), []);
  refuses("const budgetWindow = monthlyBudget / daysInMonth\n", "code-file", { codeLines });
  refuses("await bundle({ entry: 'src/main.ts', minify: true })\n", "code-file", { codeLines });
});

/* ---------------------------------------------- L2: personal and host data */

test("personal and host data are refused with an empty deny list, and the value is not echoed", () => {
  const cases = [["mail ana.lopez@acme.io today", "ana.lopez@acme.io"], ["the box at 192.168.1.20", "192.168.1.20"],
    ["10.4.0.12 is the gateway", "10.4.0.12"], ["172.20.3.4 answers", "172.20.3.4"], ["listen on 127.0.0.1", "127.0.0.1"],
    ["db1.corp is slow", "db1.corp"], ["api.internal returns 500", "api.internal"], ["the nas.lan share", "nas.lan"], ["wiki.intranet", "wiki.intranet"]];
  for (const [text, value] of cases) {
    const out = checkOutbound([{ name: "b.md", text }], EMPTY);
    assert.ok(out.some((r) => r.rule === "deny"), `expected deny for: ${text}`);
    assert.ok(!out.map(formatRefusal).join("\n").includes(value));
  }
});

test("public names, versions and figures pass the built-in floor", () => {
  passes("See example.com and docs.python.org; we run v10.2.3; growth was 8.8 percent; 172.15.0.1 is public.");
});

/* -------------------------------------------- Nilometer: links, extra keys */

function topicFixture({ guard = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "spar-harden-topic-"));
  mkdirSync(path.join(root, "dev"), { recursive: true });
  mkdirSync(path.join(root, TOPIC), { recursive: true });
  const providers = Object.fromEntries(Object.entries(BASE_CONFIG.providers).map(([n, p]) => [n, { ...p, retentionConfirmed: "test" }]));
  writeFileSync(path.join(root, "dev/spar.config.json"),
    JSON.stringify({ ...BASE_CONFIG, providers, guard: { ...BASE_CONFIG.guard, ...guard } }));
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(init); return { ok: true, status: 200, json: async () => ({}) }; };
  const deps = { env: { OPENAI_API_KEY: `sk-${"q4".repeat(24)}` }, root, ledgerFile: path.join(root, ".spar/l.jsonl"), fetchImpl, log: () => {}, now: () => new Date("2026-10-14T00:00:00Z") };
  return { root, deps, calls };
}

test("a symlinked brief is refused by send and by check, before the target is read", async () => {
  const f = topicFixture();
  const secretFile = path.join(f.root, "sealed-holdout.csv");
  writeFileSync(secretFile, "row,label\n1,yes\n");
  symlinkSync(secretFile, path.join(f.root, TOPIC, "round-1-brief.md"));
  await assert.rejects(send({ topic: TOPIC, round: "1" }, f.deps), /symbolic link/);
  await assert.rejects(main(["check", `${TOPIC}/round-1-brief.md`], f.deps), /symbolic link/);
  assert.equal(f.calls.length, 0);
});

test("a symlinked topic folder is refused", async () => {
  const f = topicFixture();
  const elsewhere = mkdtempSync(path.join(tmpdir(), "spar-elsewhere-"));
  writeFileSync(path.join(elsewhere, "round-1-brief.md"), "# Brief\nAsks: rank.\n");
  symlinkSync(elsewhere, path.join(f.root, "docs/sparring/2026-10-14-linked"));
  await assert.rejects(send({ topic: "docs/sparring/2026-10-14-linked", round: "1" }, f.deps), /symbolic link/);
});

test("guard.extraKeyEnvs: a project key from a nested .env is refused and not echoed", async () => {
  const value = "proj-llm-value-7f3a9c2e81";
  const f = topicFixture({ guard: { extraKeyEnvs: ["PROJECT_LLM_API_KEY"], keyEnvFiles: ["modules/llm/.env"] } });
  mkdirSync(path.join(f.root, "modules/llm"), { recursive: true });
  writeFileSync(path.join(f.root, "modules/llm/.env"), `PROJECT_LLM_API_KEY=${value}\n`);
  writeFileSync(path.join(f.root, TOPIC, "round-1-brief.md"), `We call the model with ${value} today.\n`);
  await assert.rejects(send({ topic: TOPIC, round: "1" }, f.deps), (err) => /\[secret\]/.test(err.message) && !err.message.includes(value));
  await assert.rejects(main(["check", `${TOPIC}/round-1-brief.md`], f.deps), (err) => /\[secret\]/.test(err.message) && !err.message.includes(value));
  assert.equal(f.calls.length, 0);
});

test("a hard-linked brief is refused", async () => {
  const f = topicFixture();
  const other = path.join(f.root, "sealed.csv");
  writeFileSync(other, "id\n1\n");
  linkSync(other, path.join(f.root, TOPIC, "round-1-brief.md"));
  await assert.rejects(send({ topic: TOPIC, round: "1" }, f.deps), /hard link/);
});

test("a planted link where the reply goes is refused, not written through", async () => {
  const f = topicFixture();
  writeFileSync(path.join(f.root, TOPIC, "round-1-brief.md"), "# Brief\nAsks: rank.\n");
  const target = path.join(f.root, "outside.md");
  symlinkSync(target, path.join(f.root, TOPIC, "sends.jsonl"));
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 1, output_tokens: 1 } }) });
  await assert.rejects(send({ topic: TOPIC, round: "1" }, { ...f.deps, fetchImpl }), /symbolic link/);
  assert.ok(!existsSync(target), "nothing was written through the link");
});

test("guard.extraKeyEnvs must be a list, and a decoy .env cannot hide the real value", async () => {
  const bad = topicFixture({ guard: { extraKeyEnvs: "PROJECT_LLM_API_KEY" } });
  writeFileSync(path.join(bad.root, TOPIC, "round-1-brief.md"), "# Brief\n");
  await assert.rejects(send({ topic: TOPIC, round: "1" }, bad.deps), /must be a list of strings/);

  const real = "real-llm-value-5d1e8a77c3";
  const f = topicFixture({ guard: { extraKeyEnvs: ["PROJECT_LLM_API_KEY"], keyEnvFiles: ["modules/llm/.env"] } });
  writeFileSync(path.join(f.root, ".env"), "PROJECT_LLM_API_KEY=decoy-value-000000\n");
  mkdirSync(path.join(f.root, "modules/llm"), { recursive: true });
  writeFileSync(path.join(f.root, "modules/llm/.env"), `PROJECT_LLM_API_KEY=${real}\n`);
  writeFileSync(path.join(f.root, TOPIC, "round-1-brief.md"), `Uses ${real}.\n`);
  await assert.rejects(send({ topic: TOPIC, round: "1" }, f.deps), (err) => /\[secret\]/.test(err.message) && !err.message.includes(real));
});
