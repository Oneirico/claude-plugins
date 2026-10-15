/**
 * Code detection for the outbound guard (#24): does a brief carry source code?
 *
 * Heuristics, not a parser — the per-send prompt is the boundary (ADR-0003).
 * They are tuned in both directions: `spar-guard-hardening.test.mjs` holds the
 * code that must be refused AND the prose that must pass, because a guard that
 * refuses ordinary briefs gets worked around.
 *
 * Keyword patterns are case-SENSITIVE on purpose. Prose capitalises its first
 * word ("Select the option", "If retries fail:"); code and SQL keywords do not
 * vary that way.
 */

/** Fence tags that hold prose or diagrams, not source. */
export const PROSE_TAGS = new Set(["", "text", "txt", "plain", "mermaid"]);

/** A strong signal: one such line next to any other code line is code. */
const STRONG = [
  /^\s*(import|export)\s+[\w{*]/,
  /^\s*from\s+[\w.]+\s+import\b/,
  /^\s*(def|class|function|fn|func)\s+\w+/,
  /^\s*(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|VIEW)|ALTER\s+TABLE|DROP\s+TABLE)\b/,
  /^\s*\$\s+\S/,
  /=>/,
];

/** A weak signal: prose can trip one now and then, so it takes company. */
const WEAK = [
  /^\s*(const|let|var|return|async|await|public|private|protected|package|using|#include|elif|lambda|raise|yield)\b/,
  /^\s*[}\])]+[;,]?\s*$/,
  /[{(]\s*$/,
  /^\s*(if|for|while|switch)\s*\(.*\)/,
  /^\s*(if|elif|else|for|while|with|try|except|finally)\b[^:]*:\s*$/,
  /\bself\.\w+/,
  /^\s*[A-Za-z_][\w.]*\(.*\)\s*;?\s*$/,
  /^\s*(WHERE|FROM|JOIN|LEFT JOIN|GROUP BY|ORDER BY|VALUES|SET|LIMIT|HAVING)\b/,
  /^\s*(sudo|npm|npx|pnpm|yarn|node|git|curl|wget|docker|kubectl|pip3?|python3?|bash|sh|cd|export|echo|cat|grep|sed|awk|make|terraform|helm|ssh|scp|psql|jq)\s+[-\w./$"'=@:]/,
  /\s&&\s/,
];

/** A line ending in `;` — but not a Markdown list item, where prose lists
 *  often end each entry with a semicolon. */
const SEMICOLON_END = /;\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/** A pipe into a tool, outside a Markdown table row. */
const PIPE_TO_TOOL = /\|\s*(grep|jq|awk|sed|sort|head|tail|xargs|wc|cut|tee)\b/;

const isStrong = (line) => STRONG.some((re) => re.test(line));
export const looksLikeCode = (line) =>
  isStrong(line) || WEAK.some((re) => re.test(line))
  || (SEMICOLON_END.test(line) && !LIST_ITEM.test(line))
  || (!/^\s*\|/.test(line) && PIPE_TO_TOOL.test(line));

/** `{python}`, `{.python}`, `python {.numberLines}`, `{.js .x}` → the language. */
export function fenceTag(info) {
  const first = info.trim().split(/\s+/)[0] ?? "";
  return first.replace(/^\{?\.?/, "").replace(/\}$/, "").toLowerCase();
}

/** Three or more `key:` lines, at least one of them nested under another. */
function looksLikeYaml(lines) {
  const keys = lines.filter((l) => /^\s*-?\s*[\w.-]+:(\s|$)/.test(l));
  const nested = lines.some((l, i) => /^\s{2,}-?\s*[\w.-]+:/.test(l) && i > 0 && /:\s*$/.test(lines[i - 1]));
  return keys.length >= 3 && nested;
}

const refusal = (name, line, label) => ({ rule: "code-block", where: name, line, label });

/** Why an untagged or `text` block reads as code, or null. */
function proseBlockVerdict(body) {
  const lines = body.filter((l) => l.trim());
  const nested = lines.find((l) => /^\s*(`{3,}|~{3,})\s*\S/.test(l));
  if (nested && !PROSE_TAGS.has(fenceTag(nested.replace(/^\s*(`{3,}|~{3,})/, "")))) return "source-tagged fence nested inside a fence";
  const code = lines.filter(looksLikeCode).length;
  if (code >= 2) return "fenced block reads as source code";
  if (lines.length && lines.length <= 3 && code === lines.length) return "short fenced block reads as source code";
  if (looksLikeYaml(lines)) return "fenced block reads as YAML";
  return null;
}

/** A diagram is not source, but a mermaid fence is no hiding place: a strong
 *  code signal (other than an arrow, which mermaid draws with `==>`) or a
 *  declaration inside one is refused. */
const DECLARATION = /^\s*(const|let|var|return)\b/;
const STRONG_NO_ARROW = STRONG.filter((re) => re.source !== "=>");
function mermaidVerdict(body) {
  const code = body.some((l) => STRONG_NO_ARROW.some((re) => re.test(l)) || DECLARATION.test(l));
  return code ? "mermaid block holds source code" : null;
}

/**
 * CommonMark fences: an opening fence may carry an info string; a closing
 * fence is the same character, at least as long, and carries NOTHING — so a
 * ```` ```python ```` line inside an open fence opens nothing and closes
 * nothing, and cannot knock the parser out of step.
 * @returns {{ blocks: {tag: string, start: number, body: string[]}[], inside: boolean[] }}
 */
export function scanFences(lines) {
  const blocks = [];
  const inside = lines.map(() => false);
  let open = null;
  lines.forEach((line, i) => {
    if (open) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      inside[i] = true;
      if (close && close[1][0] === open.mark[0] && close[1].length >= open.mark.length) { blocks.push(open); open = null; return; }
      open.body.push(line);
      return;
    }
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) { open = { mark: fence[1], tag: fenceTag(fence[2]), start: i + 1, body: [] }; inside[i] = true; }
  });
  if (open) blocks.push(open);
  return { blocks, inside };
}

/** Fenced blocks: a source-tagged fence is refused outright; a prose-tagged
 *  one by what it holds. */
export function fencedCode(name, lines) {
  const out = [];
  for (const block of scanFences(lines).blocks) {
    const why = !PROSE_TAGS.has(block.tag) ? `fenced \`${block.tag}\` block`
      : block.tag === "mermaid" ? mermaidVerdict(block.body) : proseBlockVerdict(block.body);
    if (why) out.push(refusal(name, block.start, why));
  }
  return out;
}

/** Outside fences: two consecutive code lines when one is a strong signal,
 *  or three of any kind. */
export function unfencedCode(name, lines) {
  const { inside } = scanFences(lines);
  let run = 0;
  let strong = false;
  for (let i = 0; i < lines.length; i += 1) {
    const code = !inside[i] && looksLikeCode(lines[i]);
    run = code ? run + 1 : 0;
    strong = code && (strong || isStrong(lines[i]));
    if ((run >= 2 && strong) || run >= 3) return [refusal(name, i + 2 - run, "unfenced lines read as source code")];
  }
  return [];
}

/* --------------------------------------------------------- copied code */

export const MIN_CODE_LINE = 24;

/** Always indexed, whatever `guard.codePaths` says — the config can add, not lower. */
export const CODE_PATH_FLOOR = ["modules", "src", "lib", "app", "packages", "services", "dev", "scripts", ".github"];

/** Code files at the repository root (build scripts, configs-as-code). */
export const ROOT_CODE_FILE = /^(?:Dockerfile|Makefile|Justfile|.*\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|sh|ps1|sql))$/;

/** One spelling for a line of code and a line of brief: Markdown prefixes and
 *  backticks off, whitespace collapsed, trailing `;`/`,` dropped. */
export function normalizeCode(line) {
  return line.trim()
    .replace(/^(?:>\s*|[-*+]\s+|\d+[.)]\s+)+/, "")
    .replace(/^`+|`+$/g, "")
    .replace(/\s+/g, " ")
    .replace(TRAILING, "");
}

/** Strip trailing `;`, `,` and spaces by walking back — a regex here
 *  backtracks quadratically on a long run of them. */
const TRAILING = { [Symbol.replace]: (str) => {
  let end = str.length;
  while (end > 0 && ";, ".includes(str[end - 1])) end -= 1;
  return str.slice(0, end);
} };

/** Brief lines and inline code spans, normalised, long enough to compare. */
function candidates(lines) {
  const out = [];
  lines.forEach((line, i) => {
    out.push({ text: normalizeCode(line), line: i + 1 });
    for (const m of line.matchAll(/`([^`]+)`/g)) out.push({ text: normalizeCode(m[1]), line: i + 1 });
  });
  return out.filter((c) => c.text.length >= MIN_CODE_LINE);
}

export function codeFileLines(name, lines, codeLines) {
  if (!codeLines?.size) return [];
  const hit = candidates(lines).find((c) => codeLines.has(c.text));
  return hit ? [{ rule: "code-file", where: name, line: hit.line, label: "line copied from a file under a code path" }] : [];
}
