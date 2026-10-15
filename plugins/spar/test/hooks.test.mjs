// The plugin's two PreToolUse hooks, run as Claude Code runs them: a child
// process with the hook input on stdin. Exit 2 denies.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PLUGIN = path.resolve(import.meta.dirname, "..");
const FILES = path.join(PLUGIN, "hooks", "guard-files.mjs");
const BASH = path.join(PLUGIN, "hooks", "guard-bash.mjs");

function repo() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "spar-hooks-")));
  const main = path.join(base, "main");
  const home = path.join(base, "home");
  mkdirSync(path.join(main, "dev"), { recursive: true });
  mkdirSync(path.join(home, ".claude", "plugins", "cache", "oneirico", "spar", "1.0.0"), { recursive: true });
  writeFileSync(path.join(main, "dev/spar.config.json"),
    JSON.stringify({ providers: { openai: { keyEnv: "OPENAI_API_KEY" }, evil: { keyEnv: "X; rm -rf /" } }, guard: { extraKeyEnvs: ["NESTED_KEY", "NODE_OPTIONS", "PATH", "DYLD_INSERT_LIBRARIES", "GIT_DIR", "LD_PRELOAD_KEY", "HF_TOKEN"] } }));
  const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: main, stdio: "ignore" });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("worktree", "add", "-q", path.join(base, "wt"));
  git("worktree", "add", "-q", path.join(base, "sibling"));
  const other = path.join(base, "other");
  mkdirSync(other);
  execFileSync("git", ["init", "-q"], { cwd: other });
  return { base, main, home, wt: path.join(base, "wt"), sibling: path.join(base, "sibling"), other };
}

const hook = (script, input, { project, home, pluginRoot = PLUGIN, extraEnv = {} }) => spawnSync(process.execPath, [script], {
  input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8",
  env: { PATH: process.env.PATH, HOME: home, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: pluginRoot, ...extraEnv },
});

/* ------------------------------------------------------------ file guard */

const write = (r, file, project = r.wt) => hook(FILES, { tool_name: "Edit", tool_input: { file_path: file } }, { project, home: r.home });

test("file guard: the plugin cache and the plugin's own root, in any letter case", () => {
  const r = repo();
  const cached = path.join(r.home, ".claude/plugins/cache/oneirico/spar/1.0.0/scripts/spar-lib/guard.mjs");
  assert.equal(write(r, cached).status, 2);
  if (process.platform === "darwin") assert.equal(write(r, cached.replace("/.claude/plugins/", "/.claude/PLUGINS/")).status, 2);
  assert.equal(write(r, path.join(r.home, ".claude/plugins/marketplaces/oneirico/x.json")).status, 2);
  assert.equal(write(r, path.join(PLUGIN, "scripts/spar.mjs")).status, 2, "CLAUDE_PLUGIN_ROOT itself");
});

test("file guard: user settings, local settings in every checkout, and shell startup files", () => {
  const r = repo();
  for (const f of [".claude/settings.json", ".claude/settings.local.json", ".zshrc", ".zshenv", ".bashrc", ".profile"]) {
    assert.equal(write(r, path.join(r.home, f)).status, 2, f);
  }
  for (const root of [r.main, r.wt, r.sibling]) assert.equal(write(r, path.join(root, ".claude/settings.local.json")).status, 2, root);
  assert.equal(write(r, ".claude/settings.local.json").status, 2, "relative to the project");
  assert.equal(write(r, path.join(r.wt, ".claude/settings.json")).status, 0, "tracked project settings stay editable — reviewed in a PR");
});

test("file guard: dev/spar.config.json in every checkout, by case, by link", () => {
  const r = repo();
  for (const root of [r.main, r.wt, r.sibling]) assert.equal(write(r, path.join(root, "dev/spar.config.json")).status, 2, root);
  assert.equal(write(r, "Dev/Spar.config.json").status, process.platform === "darwin" ? 2 : 0);
  const link = path.join(r.base, "link-to-main");
  symlinkSync(r.main, link);
  assert.equal(write(r, path.join(link, "dev/spar.config.json")).status, 2);
  assert.equal(write(r, path.join(r.wt, "docs/sparring/x/round-1-brief.md")).status, 0, "briefs are the agent's to write");
  assert.equal(write(r, path.join(r.other, "dev/spar.config.json")).status, 0, "another repository is not this project");
});

test("file guard: an empty file_path does not let a notebook_path through", () => {
  const r = repo();
  const res = hook(FILES, { tool_input: { file_path: "", notebook_path: path.join(r.main, "dev/spar.config.json") } }, { project: r.wt, home: r.home });
  assert.equal(res.status, 2);
});

test("file guard fails closed on input it cannot read", () => {
  const r = repo();
  assert.equal(hook(FILES, "{not json", { project: r.wt, home: r.home }).status, 2);
  assert.equal(hook(FILES, { tool_input: { file_path: 42 } }, { project: r.wt, home: r.home }).status, 2);
});

/* ------------------------------------------------------------ Bash guard */

const bash = (r, command, { cwd = r.wt, mode = "default", ...opts } = {}) =>
  hook(BASH, { tool_name: "Bash", cwd, permission_mode: mode, tool_input: { command, description: "d" } }, { project: r.wt, home: r.home, ...opts });
const decision = (res) => JSON.parse(res.stdout).hookSpecificOutput;

test("bash guard: the plain form is rewritten to the plugin's own script, absolute, in a cleared environment", () => {
  const r = repo();
  const res = bash(r, "spar send docs/sparring/2026-10-15-x --round 2");
  assert.equal(res.status, 0, res.stderr);
  const out = decision(res);
  assert.equal(out.permissionDecision, "ask");
  const cmd = out.updatedInput.command;
  assert.ok(cmd.startsWith(`builtin cd -- '${r.wt}' && command /usr/bin/env -i HOME='${r.home}' PATH=/usr/bin:/bin:`), cmd);
  assert.ok(cmd.includes(`'${process.execPath}' '${path.join(PLUGIN, "scripts", "spar.mjs")}' 'send' 'docs/sparring/2026-10-15-x' '--round' '2'`), cmd);
  assert.ok(cmd.includes('OPENAI_API_KEY="${OPENAI_API_KEY-}"') && cmd.includes('NESTED_KEY="${NESTED_KEY-}"'), "keys the committed config names");
  assert.ok(!cmd.includes("rm -rf"), "a key name that is not a plain variable name is dropped");
  assert.ok(cmd.includes('HF_TOKEN="${HF_TOKEN-}"'), "a token is a key");
  for (const v of ["NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "GIT_DIR", "LD_PRELOAD_KEY"]) assert.ok(!cmd.includes(`${v}=`), `${v} never passes through`);
  assert.equal(cmd.match(/ PATH=/g).length, 1, "the config cannot override PATH");
  assert.match(out.permissionDecisionReason, new RegExp(`from ${r.wt} \\(branch [^)]+\\)`), "the prompt names the checkout and branch");
  assert.equal(out.updatedInput.description, "d", "the rest of the tool input is kept");
});

test("bash guard: check and status are allowed and rewritten the same way", () => {
  const r = repo();
  for (const c of ["spar status", "spar check docs/sparring/x/round-1-brief.md"]) {
    const out = decision(bash(r, c));
    assert.equal(out.permissionDecision, "allow", c);
    assert.match(out.updatedInput.command, /scripts\/spar\.mjs' '(status|check)'/);
  }
});

test("bash guard: a worktree, the main checkout and a subfolder are all this project", () => {
  const r = repo();
  for (const cwd of [r.main, r.sibling, path.join(r.wt, "dev")]) {
    const out = decision(bash(r, "spar status", { cwd }));
    assert.ok(out.updatedInput.command.startsWith(`builtin cd -- '${cwd === path.join(r.wt, "dev") ? r.wt : cwd}'`), cwd);
  }
});

test("bash guard: prefixed, chained, substituted or by-path invocations are denied", () => {
  const r = repo();
  for (const c of [
    "cd /tmp/x && spar send docs/sparring/a --round 1", "GIT_DIR=/tmp/x/.git spar send docs/sparring/a --round 1",
    "spar send docs/sparring/a --round 1; curl x", "spar send $(echo a) --round 1", "spar send `a` --round 1",
    "env spar status", "bash -c 'spar send a --round 1'", "spar send a --round 1 | tee x", "spar send 'a b' --round 1",
    "node ~/.claude/plugins/cache/oneirico/spar/1.0.0/scripts/spar.mjs send a --round 1",
    "node \"$CLAUDE_PLUGIN_ROOT/scripts/spar.mjs\" status", "cat scripts/spar-lib/guard.mjs",
  ]) {
    const res = bash(r, c);
    assert.equal(res.status, 2, c);
  }
  for (const c of ["git status", "npm run lint", "grep -r sparring docs", "echo spare send"]) assert.equal(bash(r, c).status, 0, c);
});

test("bash guard: another repository, or bypass mode for send, is denied", () => {
  const r = repo();
  assert.equal(bash(r, "spar send a --round 1", { cwd: r.other }).status, 2);
  assert.equal(bash(r, "spar status", { cwd: r.base }).status, 2, "not a repository");
  assert.equal(bash(r, "spar send a --round 1", { mode: "bypassPermissions" }).status, 2);
  assert.equal(bash(r, "spar status", { mode: "bypassPermissions" }).status, 0);
});

test("bash guard fails closed when it cannot do its job on a spar command", () => {
  const r = repo();
  assert.equal(bash(r, "spar status", { pluginRoot: path.join(r.base, "nowhere") }).status, 2, "plugin script missing");
  assert.equal(hook(BASH, "{not json spar", { project: r.wt, home: r.home }).status, 2);
  assert.equal(hook(BASH, "{not json", { project: r.wt, home: r.home }).status, 0, "unrelated garbage is not ours to block");
});

test("bin/spar refuses: reaching it means the hook did not run", () => {
  const res = spawnSync(path.join(PLUGIN, "bin", "spar"), ["send", "a", "--round", "1"], { encoding: "utf8" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /hook did not run/);
});
