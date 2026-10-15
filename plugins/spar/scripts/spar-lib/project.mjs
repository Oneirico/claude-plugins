/**
 * Which project a run belongs to, and what it may trust there.
 *
 * The script lives in the plugin cache, not the project, so the project is
 * the git repository of the working directory. Nothing here reads an
 * environment variable to find it: git runs with every `GIT_*` variable
 * removed, because `GIT_DIR` or `GIT_COMMON_DIR` in front of the command
 * would otherwise move the ledger (and so reset the budget). The Bash hook
 * (hooks/guard-bash.mjs) pins the working directory to the session's project.
 * ADR-0004 in Oneirico/ProjectTemplate.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export class ProjectRefusal extends Error {}

const CONFIG = "dev/spar.config.json";

/** Only what git needs to run; never `GIT_*`, `HOME` stays for its config. */
export const gitEnv = () => ({ PATH: process.env.PATH || "/usr/bin:/bin", HOME: os.homedir() });

export function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "ignore"] }).replace(/\n$/, "");
  } catch { return null; }
}

/** The checkout the working directory is in, and its main checkout (for
 *  `.env` and the ledger). Tests inject `root` instead. */
export function roots({ root, cwd = process.cwd() } = {}) {
  if (root) return { root: path.resolve(root), main: path.resolve(root), injected: true };
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new ProjectRefusal("not inside a git repository — run spar from the project.");
  const common = git(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const real = realpathSync(top);
  return { root: real, main: common?.endsWith(`${path.sep}.git`) ? realpathSync(path.dirname(common)) : real };
}

/**
 * The config as committed at HEAD, so a widened working copy is never what
 * bounds a send. `dirty` says the working copy differs; `send` refuses on it.
 * An injected (test) root reads the working file.
 */
export function loadConfig({ root, injected }) {
  if (injected) return { config: JSON.parse(readFileSync(path.join(root, CONFIG), "utf8")), dirty: false };
  const committed = git(root, ["show", `HEAD:${CONFIG}`]);
  if (committed === null) throw new ProjectRefusal(`${CONFIG} is not committed in this repository — the owner commits it first.`);
  const file = path.join(root, CONFIG);
  const working = existsSync(file) ? readFileSync(file, "utf8").replace(/\n$/, "") : null;
  return { config: JSON.parse(committed), dirty: working !== committed };
}

/** This plugin's own version, from its manifest. */
export const pluginVersion = () =>
  JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "..", ".claude-plugin", "plugin.json"), "utf8")).version;

/** null when the project pins exactly this version; otherwise why not. */
export function pinProblem(config, running = pluginVersion()) {
  const pinned = config.plugin?.version;
  if (typeof pinned !== "string" || !pinned) return `${CONFIG} pins no plugin version (plugin.version); running ${running}.`;
  if (pinned !== running) return `${CONFIG} pins spar ${pinned}, but ${running} is installed. The owner reads the release notes and review record, then bumps the pin — or installs ${pinned}.`;
  return null;
}

/** Commands a send runs as: the plain form, the hook's whole rewrite, and
 *  each `&&` part of it (Claude Code matches compound commands part by part). */
const REWRITE = "builtin cd -- '/p' && command /usr/bin/env -i HOME='/h' PATH=/usr/bin:/bin OPENAI_API_KEY=\"${OPENAI_API_KEY-}\" "
  + "'/usr/local/bin/node' '/h/.claude/plugins/cache/oneirico/spar/1.0.0/scripts/spar.mjs' 'send' 'docs/sparring/x' '--round' '1'";
const UNQUOTED = REWRITE.replace(/'/g, ""); // conservative: also as a rule author might picture it
// Only the part that runs the script matters: allowing `cd` alone sends nothing.
const parts = (c) => c.split(" && ").filter((p) => p.includes("spar.mjs")).flatMap((p) => [p, p.replace(/^(?:builtin|command) /, ""), p.replace(/^command \/usr\/bin\//, "")]);
export const SEND_FORMS = ["spar send docs/sparring/x --round 1", ...[REWRITE, UNQUOTED].flatMap((c) => [c, ...parts(c)])];

/** A rule's pattern as a regex: `*` matches anything, and a trailing `:*`
 *  is the legacy prefix form. */
function ruleRegex(inner) {
  const body = inner.replace(/:\*$/, "*");
  const escaped = body.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`, "s");
}

/** A `Bash` allow rule that would let `spar send` (or its rewrite) run
 *  without a prompt. The per-send prompt is the boundary (ADR-0003). */
export function allowsSend(rule) {
  if (typeof rule !== "string") return false;
  const m = /^Bash(?:\((.*)\))?$/s.exec(rule.trim());
  if (!m) return false;
  const inner = (m[1] ?? "*").trim();
  if (/spar\.mjs|spar-lib|\.claude\/plugins/i.test(inner) || /^spar\s+send\b/.test(inner)) return true;
  const re = ruleRegex(inner || "*");
  return SEND_FORMS.some((form) => re.test(form));
}

/** Every settings file a session here would load that the script can read. */
export function settingsFiles({ root, main }, home = os.homedir()) {
  const dirs = [...new Set([root, main])].map((d) => path.join(d, ".claude"));
  dirs.push(path.join(home, ".claude"));
  return dirs.flatMap((d) => ["settings.json", "settings.local.json"].map((f) => path.join(d, f)));
}

/** Allow rules that skip the per-send prompt, as `file: rule` lines. */
export function sendAllowRules(files) {
  const found = [];
  for (const file of files) {
    let json;
    try { json = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
    if (json?.permissions?.defaultMode === "bypassPermissions") found.push(`${file}: defaultMode bypassPermissions`);
    for (const rule of json?.permissions?.allow ?? []) if (allowsSend(rule)) found.push(`${file}: ${rule}`);
  }
  return found;
}
