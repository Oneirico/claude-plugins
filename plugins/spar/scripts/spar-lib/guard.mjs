/**
 * The outbound guard for design sparring: what may leave the repository for an
 * outside model, decided BEFORE every send.
 *
 * The partner is a critic of plans and needs only the brief, never the code,
 * so the guard refuses anything that is code, secret, sealed, or too big. A
 * refusal names the rule, the file and the line, and NEVER the matched text —
 * the refusal is printed into an agent transcript, and echoing a secret there
 * would be the leak the guard exists to stop.
 *
 * There is deliberately no override. A false positive is fixed by the owner
 * editing the brief (or, for patterns, the owner-only config), not by a flag
 * an agent could pass.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { CODE_PATH_FLOOR, codeFileLines, fencedCode, MIN_CODE_LINE, normalizeCode, ROOT_CODE_FILE, unfencedCode } from "./code-detect.mjs";

export const SECRET_PATTERNS = [
  { label: "OpenAI/Anthropic-style API key", re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/ },
  { label: "Stripe-style key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/ },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { label: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})/ },
  { label: "GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { label: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { label: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "JSON web token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { label: "bearer or basic credential", re: /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { label: "credentials in a URL", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i },
  {
    // Case-insensitive, so `password = …`, `apiKey: …` and `CLIENT_SECRET=…` all count. The value
    // must hold a digit, so prose like "Password policy: minimum-length" is not refused.
    label: "secret-named assignment",
    re: /\b[\w.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|private[_-]?key|access[_-]?key|credential)[\w.-]*["']?\s*[=:]\s*["']?(?=[^\s"'<>|,;]*\d)[^\s"'<>|,;]{8,}/i,
  },
  { label: ".env-style connection or credential line", re: /\b[A-Z][A-Z0-9_]*(?:URL|URI|DSN|CONN\w*|HOST|USER\w*)=\S{4,}/ },
];

/**
 * Personal and host data refused whatever `guard.deny` says — the config can
 * add patterns, not lower these (#24). Briefs describe domains in general
 * terms; a real address, private IP or internal hostname is never needed.
 */
export const BUILTIN_DENY = [
  // The domain starts with a letter and ends in a letters-only TLD, so
  // `lodash@4.17.21` and `@scope/pkg@1.2.0` are not addresses.
  { label: "built-in: email address", re: /\b[\w.+-]+@[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/ },
  { label: "built-in: private IPv4 address", re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/ },
  { label: "built-in: loopback address", re: /\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
  // Not `.env.local`, and not a file name like `settings.local.json`.
  { label: "built-in: internal hostname", re: /\b(?!env\.)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|local|corp|lan|intranet)(?!\.?[A-Za-z0-9_-])/i },
];

/** Characters that render as nothing and would split a pattern apart. */
const INVISIBLE = /[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g;

const ENV_LINE = /^\s*(?:export\s+)?[A-Z][A-Z0-9_]{2,}=\S+/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "target", "vendor", "__pycache__", ".venv"]);

const refusal = (rule, where, line, label) => ({ rule, where, line, label });

function secrets(name, lines, secretValues) {
  const out = [];
  const values = secretValues.filter((v) => typeof v === "string" && v.length >= 8);
  let envLines = 0;
  lines.forEach((line, i) => {
    for (const { label, re } of SECRET_PATTERNS) if (re.test(line)) out.push(refusal("secret", name, i + 1, label));
    if (values.some((v) => line.includes(v))) out.push(refusal("secret", name, i + 1, "a configured key value"));
    if (ENV_LINE.test(line)) envLines += 1;
  });
  if (envLines >= 2) out.push(refusal("secret", name, 0, ".env-style assignments"));
  return out;
}

function patterns(rule, name, lines, entries) {
  const out = [];
  for (const { label, re } of entries) {
    const i = lines.findIndex((line) => re.test(line));
    if (i >= 0) out.push(refusal(rule, name, i + 1, label));
  }
  return out;
}

/** `{ label, pattern }` config entries → case-insensitive regexes. A bad
 *  pattern is a config error, not a pass. */
export function compilePatterns(entries = [], kind = "pattern") {
  return entries.map(({ label, pattern }) => {
    if (typeof pattern !== "string" || !pattern) throw new Error(`spar config: ${kind} "${label}" has no pattern`);
    return { label: label || kind, re: new RegExp(pattern, "i") };
  });
}

/**
 * Check every text a request would carry.
 * @param {{name: string, text: string, brief?: boolean}[]} texts
 * @param {{guard: object}} config
 * @param {{codeLines?: Set<string>, secretValues?: string[]}} [extra]
 * @returns {{rule: string, where: string, line: number, label: string}[]}
 */
/** Longer lines are refused unread: no brief needs one, and the patterns
 *  below are only fast on lines of ordinary length. */
export const MAX_LINE_CHARS = 4000;

/** Size first, before any pattern runs: an oversize text is refused on size
 *  alone, so no regex ever sees it. */
function sizeRefusals(texts, g) {
  const out = [];
  let total = 0;
  for (const { name, text, brief = true } of texts) {
    total += text.length;
    if (brief && text.length > g.maxBriefChars) out.push(refusal("size", name, 0, `over maxBriefChars (${g.maxBriefChars})`));
    const long = text.split(/\r?\n/).findIndex((l) => l.length > MAX_LINE_CHARS);
    if (long >= 0) out.push(refusal("size", name, long + 1, `a line over ${MAX_LINE_CHARS} characters`));
  }
  if (total > g.maxRequestChars) out.push(refusal("size", "request", 0, `over maxRequestChars (${g.maxRequestChars})`));
  return out;
}

export function checkOutbound(texts, config, { codeLines, secretValues = [] } = {}) {
  const g = config.guard ?? {};
  const sealed = compilePatterns(g.sealed, "sealed");
  const deny = [...BUILTIN_DENY, ...compilePatterns(g.deny, "deny")];
  const tooBig = sizeRefusals(texts, g);
  if (tooBig.length) return tooBig;
  const out = [];
  for (const { name, text } of texts) {
    const lines = text.replace(INVISIBLE, "").split(/\r?\n/);
    out.push(...fencedCode(name, lines), ...unfencedCode(name, lines), ...secrets(name, lines, secretValues),
      ...patterns("sealed", name, lines, sealed), ...patterns("deny", name, lines, deny),
      ...codeFileLines(name, lines, codeLines));
  }
  return out;
}

function walk(dir, files, limit) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (files.length >= limit) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(p, files, limit);
    else if (e.isFile() && !e.name.startsWith(".env")) files.push(p);
  }
}

/** Every normalised line of ≥ 24 chars in the text files under the code
 *  paths — the built-in floor plus `guard.codePaths` — and in root code files.
 *  `.env*` files are skipped: their values are caught by the secret rules,
 *  and reading them here would put them in memory for nothing. */
export function indexCodeLines(root, codePaths = [], { limit = 20000, maxBytes = 1_000_000 } = {}) {
  const files = [];
  for (const rel of new Set([...CODE_PATH_FLOOR, ...codePaths])) walk(path.join(root, rel), files, limit);
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) if (e.isFile() && ROOT_CODE_FILE.test(e.name)) files.push(path.join(root, e.name));
  } catch { /* no root: nothing to index */ }
  const lines = new Set();
  for (const file of files) {
    let buf;
    try { if (statSync(file).size > maxBytes) continue; buf = readFileSync(file); } catch { continue; }
    if (buf.includes(0)) continue;
    for (const line of buf.toString("utf8").split(/\r?\n/)) {
      const t = normalizeCode(line);
      if (t.length >= MIN_CODE_LINE) lines.add(t);
    }
  }
  return lines;
}

/** One line per refusal, safe to print: no matched text. */
export const formatRefusal = ({ rule, where, line, label }) =>
  `  [${rule}] ${where}${line ? `:${line}` : ""} — ${label}`;
