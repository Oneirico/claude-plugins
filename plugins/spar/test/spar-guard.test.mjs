// The outbound guard is the only thing between a brief and an outside
// provider. Each rule is asserted to refuse, a realistic brief to pass, and a
// refusal never to carry the text it matched.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkOutbound, formatRefusal, indexCodeLines } from "../scripts/spar-lib/guard.mjs";

const CONFIG = {
  guard: {
    maxBriefChars: 2000,
    maxRequestChars: 5000,
    codePaths: ["modules"],
    sealed: [{ label: "sealed holdout set", pattern: "holdout-[0-9]{4}" }],
    deny: [{ label: "customer hostname", pattern: "\\b[a-z0-9-]+\\.acme-customer\\.com\\b" }],
  },
};

// Built at runtime so no file in the repo carries a key-shaped literal.
const FAKE_OPENAI = `sk-${"x9".repeat(24)}`;
const FAKE_GOOGLE = `AIza${"Q".repeat(35)}`;

const rules = (text, extra) => checkOutbound([{ name: "round-1-brief.md", text }], CONFIG, extra).map((r) => r.rule);
const refusesWith = (text, rule, extra) => assert.ok(rules(text, extra).includes(rule), `expected ${rule}, got ${rules(text, extra)}`);

const CLEAN = `# Brief: retry policy for the ingest job

## Context
The ingest job fails about 4% of nights. We want a retry policy.

| Option | Retries | Cost |
|--------|---------|------|
| A | 3 fixed | low |
| B | exponential | medium |

\`\`\`mermaid
flowchart LR
  A[fetch] --> B{ok?};
  B -->|no| A;
\`\`\`

\`\`\`text
night 1: fail, night 2: ok
\`\`\`

## Asks
1. Rank A and B. 2. Cut what is not needed. 3. Find the holes.
`;

test("a realistic brief with tables, a diagram and a text block passes", () => {
  assert.deepEqual(rules(CLEAN), []);
});

test("code blocks: a source-tagged fence is refused", () => {
  refusesWith("Plan:\n```js\nconst a = 1;\n```\n", "code-block");
  refusesWith("```python\nprint('x')\n```", "code-block");
});

test("code blocks: an untagged fence that reads as code is refused", () => {
  refusesWith("```\nimport fs from 'fs';\nfunction go() {\n  return 1;\n}\n```", "code-block");
});

test("code blocks: three code lines outside any fence are refused", () => {
  refusesWith("Here is how:\nconst a = load();\nconst b = parse(a);\nreturn b;\n", "code-block");
});

test("code paths: a line copied verbatim from a file under modules/ is refused", () => {
  const root = mkdtempSync(path.join(tmpdir(), "spar-guard-"));
  mkdirSync(path.join(root, "modules/web/src"), { recursive: true });
  writeFileSync(path.join(root, "modules/web/src/rate.ts"), "export const backoffWindowMs = computeWindow(cfg.retries) * 1.5\n");
  writeFileSync(path.join(root, "modules/web/.env"), "SHOULD_NOT_BE_INDEXED_ANYWAY=1234567890abcdefghijklmnop\n");
  const codeLines = indexCodeLines(root, ["modules"]);
  assert.equal(codeLines.size, 1, "the .env file is not indexed");
  refusesWith("The window is:\n  export const backoffWindowMs = computeWindow(cfg.retries) * 1.5\n", "code-file", { codeLines });
  assert.deepEqual(rules("We compute a backoff window from the retry count.", { codeLines }), []);
});

test("secrets: each key shape is refused", () => {
  const samples = [
    FAKE_OPENAI,
    FAKE_GOOGLE,
    `ghp_${"a".repeat(36)}`,
    `AKIA${"B".repeat(16)}`,
    "-----BEGIN RSA PRIVATE KEY-----",
    `eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.${"c".repeat(12)}`,
    "postgres://app:hunter22@db.internal/app",
    "SERVICE_TOKEN=abcdef123456",
    "password = hunter2hunter2",
    "apiKey: abcdefghijklmnop1234",
    `sk_live_${"a1".repeat(8)}`,
    `Authorization: Bearer ${"t0k".repeat(8)}`,
    "DATABASE_URL=postgres://host/db",
    `glpat-${"x".repeat(20)}`,
  ];
  for (const s of samples) refusesWith(`Context: ${s}`, "secret");
});

test("secrets: invisible characters do not split a key apart", () => {
  refusesWith(`key ${FAKE_OPENAI.slice(0, 10)}\u200B${FAKE_OPENAI.slice(10)}`, "secret");
});

test("secrets: prose about passwords and tokens is not refused", () => {
  assert.deepEqual(rules("Password policy: minimum-length rules apply.\nTokens: about a million per night.\nA basic understanding of retries."), []);
});

test("secrets: .env-style contents are refused", () => {
  refusesWith("LOG_LEVEL=debug\nREGION=eu-west-1\n", "secret");
});

test("secrets: the live key value is refused even in an unknown shape", () => {
  refusesWith("we use key plain-value-123456 here", "secret", { secretValues: ["plain-value-123456"] });
});

test("a refusal never carries the matched text", () => {
  const out = checkOutbound([{ name: "b.md", text: `key ${FAKE_OPENAI}` }], CONFIG).map(formatRefusal).join("\n");
  assert.match(out, /\[secret\] b\.md:1/);
  assert.ok(!out.includes(FAKE_OPENAI));
});

test("sealed and deny-list patterns are refused under their own rule", () => {
  refusesWith("Tune on HOLDOUT-2024 once.", "sealed");
  refusesWith("Seen on eu1.acme-customer.com last week.", "deny");
});

test("size: an oversize brief and an oversize request are refused", () => {
  refusesWith("a".repeat(2001), "size");
  const texts = [1, 2, 3].map((n) => ({ name: `r${n}`, text: "b".repeat(1900) }));
  assert.ok(checkOutbound(texts, CONFIG).some((r) => r.rule === "size" && r.where === "request"));
});

test("a bad config pattern is an error, not a pass", () => {
  assert.throws(() => checkOutbound([{ name: "b", text: "x" }], { guard: { ...CONFIG.guard, sealed: [{ label: "x", pattern: "(" }] } }));
});
