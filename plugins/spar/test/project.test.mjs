// The project a run belongs to (ADR-0004 in Oneirico/ProjectTemplate): root
// and ledger from the working directory's repository, never the environment;
// config from the committed HEAD; the project's version pin; and no settings
// file may skip the per-send prompt. Every send here is a MOCKED fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { allowsSend, pinProblem, pluginVersion, roots, sendAllowRules } from "../scripts/spar-lib/project.mjs";
import { check, send, status } from "../scripts/spar.mjs";

const BASE = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "spar.config.json"), "utf8"));
const TOPIC = "docs/sparring/2026-10-15-pin";
const KEY = `sk-${"p9".repeat(24)}`;
const REPLY = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok\nVERDICT: AGREE" }] }],
  usage: { input_tokens: 10, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 } } };

function run(cwd, ...args) {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
}

/** A committed project with a main checkout and a worktree, and an empty home. */
function projectRepo({ config = {} } = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "spar-project-")));
  const main = path.join(base, "main");
  const home = path.join(base, "home");
  mkdirSync(path.join(main, "dev"), { recursive: true });
  mkdirSync(path.join(main, TOPIC), { recursive: true });
  mkdirSync(home);
  const providers = Object.fromEntries(Object.entries(BASE.providers).map(([n, p]) => [n, { ...p, retentionConfirmed: "test" }]));
  writeFileSync(path.join(main, "dev/spar.config.json"), JSON.stringify({ ...BASE, providers, plugin: { version: pluginVersion() }, ...config }, null, 2) + "\n");
  writeFileSync(path.join(main, TOPIC, "round-1-brief.md"), "# Brief\n\nAsks: rank the options.\n");
  run(main, "init", "-q");
  run(main, "add", ".");
  run(main, "commit", "-q", "-m", "init");
  const wt = path.join(base, "wt");
  run(main, "worktree", "add", "-q", wt);
  return { base, main, wt, home };
}

function deps(cwd, home, extra = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(init); return { ok: true, status: 200, json: async () => REPLY }; };
  const logs = [];
  return { calls, logs, deps: { cwd, home, env: { OPENAI_API_KEY: KEY }, fetchImpl, log: (l) => logs.push(l), now: () => new Date("2026-10-15T12:00:00Z"), ...extra } };
}

test("root is the working directory's checkout; the ledger is its main checkout's", () => {
  const { main, wt } = projectRepo();
  assert.deepEqual(roots({ cwd: path.join(wt, "dev") }), { root: wt, main });
  assert.deepEqual(roots({ cwd: main }), { root: main, main });
});

test("GIT_DIR and GIT_COMMON_DIR cannot move the root or the ledger", () => {
  const { main, wt } = projectRepo();
  const decoy = projectRepo();
  const saved = { ...process.env };
  try {
    process.env.GIT_DIR = path.join(decoy.main, ".git");
    process.env.GIT_COMMON_DIR = path.join(decoy.main, ".git");
    process.env.GIT_WORK_TREE = decoy.main;
    assert.deepEqual(roots({ cwd: wt }), { root: wt, main });
  } finally {
    for (const k of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"]) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

test("outside a repository, or with no committed config, every subcommand refuses", async () => {
  const bare = realpathSync(mkdtempSync(path.join(tmpdir(), "spar-norepo-")));
  assert.throws(() => status({ cwd: bare, log: () => {} }), /not inside a git repository/);
  run(bare, "init", "-q");
  run(bare, "commit", "-q", "--allow-empty", "-m", "x");
  assert.throws(() => status({ cwd: bare, log: () => {} }), /not committed/);
  await assert.rejects(send({ topic: TOPIC, round: "1" }, { cwd: bare }), /not committed/);
});

test("send uses the committed config and refuses a working copy that differs", async () => {
  const { wt, home } = projectRepo();
  const cfg = path.join(wt, "dev/spar.config.json");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace('"monthlyBudgetUsd": 50', '"monthlyBudgetUsd": 999999'));
  const { calls, deps: d } = deps(wt, home);
  await assert.rejects(send({ topic: TOPIC, round: "1" }, d), /differs from the committed copy/);
  assert.equal(calls.length, 0);
  const s = deps(wt, home);
  status(s.deps);
  assert.ok(s.logs.some((l) => /\$50\b/.test(l)), "status shows the committed budget, not the widened one");
  assert.ok(s.logs.some((l) => /differs from the committed copy/.test(l)));
});

test("send works end to end from a worktree, and records in the main checkout's ledger", async () => {
  const { main, wt, home } = projectRepo();
  const { calls, deps: d } = deps(wt, home);
  await send({ topic: TOPIC, round: "1" }, d);
  assert.equal(calls.length, 1);
  assert.ok(existsSync(path.join(main, ".spar/ledger.jsonl")));
  assert.ok(!existsSync(path.join(wt, ".spar")));
});

test("the version pin: send refuses a mismatch either way; status and check report it", async () => {
  for (const version of ["0.9.0", "99.0.0", undefined]) {
    const { wt, home } = projectRepo({ config: { plugin: version ? { version } : undefined } });
    const { calls, deps: d } = deps(wt, home);
    await assert.rejects(send({ topic: TOPIC, round: "1" }, d), version ? new RegExp(`pins spar ${version.replace(/\./g, "\\.")}`) : /pins no plugin version/);
    assert.equal(calls.length, 0);
    const s = deps(wt, home);
    status(s.deps);
    assert.ok(s.logs.some((l) => l.startsWith(`plugin spar ${pluginVersion()} · project pins ${version ?? "nothing"}`)));
    assert.ok(s.logs.some((l) => /^warning: .*pins/.test(l)));
    const c = deps(wt, home);
    check([`${TOPIC}/round-1-brief.md`], c.deps);
    assert.ok(c.logs.some((l) => /^warning: .*pins/.test(l)));
  }
  assert.equal(pinProblem({ plugin: { version: pluginVersion() } }), null);
});

test("allowsSend: rules that would skip the send prompt, and rules that would not", () => {
  for (const r of ["Bash", "Bash(*)", "Bash(:*)", "Bash(spar:*)", "Bash(spar *)", "Bash(spar send:*)", "Bash(spar send docs/sparring/x --round 2)",
    "Bash(sp:*)", "Bash(*spar*)", "Bash(* send *)", "Bash(*/node *)", "Bash(*spar.mjs*)", "Bash(command:*)", "Bash(builtin:*)", "Bash(/usr/bin/env:*)", "Bash(env:*)", "Bash(node /x/.claude/plugins/cache/o/spar/1/scripts/spar.mjs:*)"]) {
    assert.ok(allowsSend(r), r);
  }
  for (const r of ["Bash(spar check:*)", "Bash(spar status)", "Bash(npm run lint)", "Read(./x)", "Bash(git status)", "Bash(cd:*)"]) {
    assert.ok(!allowsSend(r), r);
  }
});

test("send refuses while a project-local, main-checkout or user settings file skips its prompt", async () => {
  for (const where of ["wt-local", "main", "home", "bypass"]) {
    const { main, wt, home } = projectRepo();
    const dir = { "wt-local": wt, main, home, bypass: home }[where];
    mkdirSync(path.join(dir, ".claude"), { recursive: true });
    const file = path.join(dir, ".claude", where === "wt-local" ? "settings.local.json" : "settings.json");
    const perms = where === "bypass" ? { defaultMode: "bypassPermissions" } : { allow: ["Bash(spar send:*)"] };
    writeFileSync(file, JSON.stringify({ permissions: perms }));
    const { calls, deps: d } = deps(wt, home);
    await assert.rejects(send({ topic: TOPIC, round: "1" }, d), (e) => /without a prompt/.test(e.message) && e.message.includes(file), where);
    assert.equal(calls.length, 0);
  }
  assert.deepEqual(sendAllowRules([path.join(tmpdir(), "no-such-settings.json")]), []);
});
