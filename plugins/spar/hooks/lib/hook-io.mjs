/**
 * What both spar hooks share: reading the hook input, resolving paths to
 * their real on-disk spelling, and the checkouts of the session's project.
 * A copy of the logic in ProjectTemplate's guard-paths.mjs, because a plugin
 * cannot import from a project. Git runs with every `GIT_*` variable removed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

export function readStdin() {
  return new Promise((done) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => done(data));
    if (process.stdin.isTTY) done("");
  });
}

/** Deny with a reason Claude sees, and stop. */
export function deny(reason) {
  process.stderr.write(`spar plugin: ${reason}\n`);
  process.exit(2);
}

export const gitEnv = () => ({ PATH: process.env.PATH || "/usr/bin:/bin", HOME: os.homedir() });

export function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "ignore"] }).replace(/\n$/, "");
  } catch { return null; }
}

/** The real spelling of a path that may not exist yet: the deepest existing
 *  parent through `realpathSync.native` (links and, on macOS, letter case),
 *  then the missing tail as written. Lower-cased for comparison: APFS and
 *  NTFS are case-insensitive by default, so `Dev/Spar.config.json` is the file. */
export function canonical(abs) {
  let head = resolve(abs);
  const tail = [];
  while (!existsSync(head) && dirname(head) !== head) { tail.unshift(basename(head)); head = dirname(head); }
  try { head = realpathSync.native(head); } catch { /* keep it as resolved */ }
  return join(head, ...tail).toLowerCase();
}

/** `child` is `parent` or inside it (both canonical). */
export const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** The shared `.git` of a checkout, canonical; null outside a repository. */
export function commonDir(cwd) {
  const out = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return out ? canonical(out) : null;
}

/** Every checkout of the session's project — this one, the main checkout
 *  and every sibling worktree — canonical. */
export function checkouts(projectDir) {
  const roots = [projectDir];
  const out = git(projectDir, ["worktree", "list", "--porcelain"]);
  for (const line of (out ?? "").split("\n")) if (line.startsWith("worktree ")) roots.push(line.slice(9));
  return [...new Set(roots.map(canonical))];
}
