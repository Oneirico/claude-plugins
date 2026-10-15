#!/usr/bin/env node
/**
 * PreToolUse (Write|Edit|MultiEdit|NotebookEdit) — the guard cannot be
 * widened by the agent it guards (ADR-0003 §3.3, restated in ADR-0004 §3.7).
 *
 * Denies file-tool writes to:
 *   - the plugin itself and every installed plugin (~/.claude/plugins/**)
 *   - user settings, and each checkout's untracked settings.local.json — the
 *     files that could allow-list `spar send` and so skip its prompt
 *   - shell startup files, which could shadow `spar`, `cd` or `node`
 *   - dev/spar.config.json in every checkout of the session's project
 * Case-insensitively, after resolving links. FAILS CLOSED: any error denies.
 * The project's tracked .claude/settings.json stays editable — a change to it
 * is reviewed and disclosed in its PR.
 */
import os from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { canonical, checkouts, deny, readStdin, within } from "./lib/hook-io.mjs";

const STARTUP = [".zshrc", ".zshenv", ".zprofile", ".zlogin", ".bashrc", ".bash_profile", ".bash_login", ".profile"];

function forbidden(file, { projectDir, pluginRoot, home = os.homedir() }) {
  const abs = canonical(isAbsolute(file) ? file : resolve(projectDir, file));
  const plugins = [canonical(join(home, ".claude", "plugins")), pluginRoot && canonical(pluginRoot)].filter(Boolean);
  if (plugins.some((p) => within(abs, p))) return "an installed plugin's files — plugins are released, not edited in place.";
  for (const f of ["settings.json", "settings.local.json"]) {
    if (abs === canonical(join(home, ".claude", f))) return `user settings (~/.claude/${f}) — an allow rule there would skip the spar send prompt.`;
  }
  if (STARTUP.some((f) => abs === canonical(join(home, f)))) return "a shell startup file — it runs before every Bash command, so it could stand in for spar.";
  for (const root of checkouts(projectDir)) {
    const rel = relative(root, abs).split("\\").join("/");
    if (rel === ".claude/settings.local.json") return "untracked local settings — an allow rule there would skip the spar send prompt unreviewed.";
    if (rel === "dev/spar.config.json") return "design-sparring config (budget, prices, guard patterns, plugin pin) — owner-only.";
  }
  return null;
}

async function main() {
  const raw = await readStdin();
  const input = JSON.parse(raw);
  const t = input?.tool_input ?? {};
  // Every path field present is checked: an empty `file_path` must not let a
  // `notebook_path` through.
  const files = ["file_path", "filePath", "notebook_path"].filter((k) => t[k] !== undefined).map((k) => t[k]);
  if (files.some((f) => typeof f !== "string")) throw new Error("file path is not a string");
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  for (const file of files.filter(Boolean)) {
    const why = forbidden(file, { projectDir, pluginRoot: process.env.CLAUDE_PLUGIN_ROOT });
    if (why) deny(`blocked write to ${file}: ${why} The owner makes this change. See ADR-0004.`);
  }
}

main().then(() => process.exit(0), (err) => deny(`file guard failed (${err.message}), so the write is denied. Fails closed by design.`));
