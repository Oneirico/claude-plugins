#!/usr/bin/env node
/**
 * PreToolUse (Bash) — the command the human approves is the code that runs
 * (ADR-0004 §3.5 in Oneirico/ProjectTemplate).
 *
 *   - A command naming the plugin's files (spar.mjs, spar-lib, the plugin
 *     cache, CLAUDE_PLUGIN_ROOT) is denied: the script runs only through here.
 *   - `spar` used as a command must be the plain form, `spar check|send|status`
 *     with plain arguments — no cd, environment prefix, chaining or
 *     substitution — run from a checkout of the session's project.
 *   - The plain form is rewritten to an absolute call: into that checkout,
 *     a cleared environment (HOME, a fixed system-first PATH for git, the key variables the
 *     committed config names), this hook's own node, this plugin's script. A
 *     `spar` earlier on PATH, an alias, a function or NODE_OPTIONS cannot
 *     stand in for it.
 *   - `send` always asks; under bypassPermissions it is denied, because the
 *     per-send prompt is the boundary (ADR-0003). `check` and `status` are
 *     offline and read only briefs and the ledger, so they are allowed.
 * FAILS CLOSED: an error on input that mentions spar denies.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { commonDir, deny, git, readStdin } from "./lib/hook-io.mjs";

const MENTIONS_PLUGIN = /spar\.mjs|spar-lib|\.claude[\\/]+plugins|plugins[\\/]+cache|CLAUDE_PLUGIN_(ROOT|DATA)/i;
const INVOKES = /(^|[^\w.\/-])spar\s+(check|send|status)\b/;
const PLAIN = /^\s*spar\s+(check|send|status)((?:[ \t]+[A-Za-z0-9._/=-]+)*)\s*$/;
const KEY_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** For git only — node is called by absolute path. System locations first,
 *  so a `git` planted in a user directory does not answer for the project. */
const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Key variable names the committed config sends with or guards. */
function keyNames(checkout) {
  let config;
  try { config = JSON.parse(git(checkout, ["show", "HEAD:dev/spar.config.json"]) ?? "{}"); } catch { return []; }
  const names = [...Object.values(config.providers ?? {}).map((p) => p?.keyEnv), ...(config.guard?.extraKeyEnvs ?? [])];
  return [...new Set(names)].filter((n) => typeof n === "string" && KEY_NAME.test(n));
}

/** The checkout to run in: the hook's cwd, if it belongs to the session's project. */
function verifiedCheckout(cwd, projectDir) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) deny(`spar runs only inside the session's project; ${cwd} is not in a git repository.`);
  const mine = commonDir(projectDir);
  if (!mine || commonDir(top) !== mine) deny(`spar runs only inside the session's project (${projectDir}); ${top} is another repository.`);
  return top;
}

function rewrite({ sub, args, checkout, pluginRoot, keys }) {
  const env = [`HOME=${q(os.homedir())}`, `PATH=${SAFE_PATH}`, ...keys.map((k) => `${k}="\${${k}-}"`)];
  return `builtin cd -- ${q(checkout)} && command /usr/bin/env -i ${env.join(" ")} ${q(process.execPath)} ${q(join(pluginRoot, "scripts", "spar.mjs"))} ${[sub, ...args].map(q).join(" ")}`;
}

function decide(input) {
  const command = input?.tool_input?.command;
  if (typeof command !== "string") throw new Error("command is not a string");
  if (MENTIONS_PLUGIN.test(command)) deny("the spar plugin's files run only as `spar check|send|status` — never by path or by another command.");
  const m = PLAIN.exec(command);
  if (!m) {
    if (INVOKES.test(command)) deny("run spar on its own, in its plain form: `spar check <brief>…`, `spar send <topic-dir> --round N`, `spar status` — no cd, environment prefix, chaining or substitution.");
    return null;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!projectDir || !pluginRoot) throw new Error("CLAUDE_PROJECT_DIR or CLAUDE_PLUGIN_ROOT is not set");
  if (!existsSync(join(pluginRoot, "scripts", "spar.mjs"))) throw new Error("the plugin's script is missing");
  const sub = m[1];
  if (sub === "send" && input.permission_mode === "bypassPermissions") {
    deny("spar send needs its permission prompt, and this session bypasses permissions. Leave bypass mode to send.");
  }
  const checkout = verifiedCheckout(input.cwd || projectDir, projectDir);
  const command2 = rewrite({ sub, args: m[2].trim().split(/\s+/).filter(Boolean), checkout, pluginRoot, keys: keyNames(checkout) });
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: sub === "send" ? "ask" : "allow",
      permissionDecisionReason: sub === "send"
        ? "spar send crosses to an outside model. Approve only this exact command; it runs the plugin's own script."
        : `spar ${sub} is offline and reads only briefs and the ledger.`,
      updatedInput: { ...input.tool_input, command: command2 },
    },
  };
}

const raw = await readStdin();
try {
  const out = decide(JSON.parse(raw));
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
} catch (err) {
  if (/\bspar\b/i.test(raw) || MENTIONS_PLUGIN.test(raw)) deny(`Bash guard failed (${err.message}), so the command is denied. Fails closed by design.`);
  process.exit(0);
}
