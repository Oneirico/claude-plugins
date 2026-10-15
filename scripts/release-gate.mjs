#!/usr/bin/env node
/**
 * Release gate — every change to a plugin is a release, every release is
 * reviewed, and what installs is exactly what was reviewed (ADR-0004 in
 * Oneirico/ProjectTemplate).
 *
 *   node scripts/release-gate.mjs <base-ref>
 *
 * For each plugins/<name>/ that changed since <base-ref>:
 *   - its plugin.json version moved forward (semver);
 *   - its CHANGELOG.md has a `## <version>` section.
 * For EVERY marketplace entry, on every run:
 *   - it installs `git-subdir` from this repository's canonical URL, path
 *     plugins/<name>, pinned by a full 40-hex `sha` and the tag `<name>-v<version>`;
 *   - that sha is already in this history, carries version <version>, and its
 *     plugins/<name>/ is byte-identical to HEAD's — so installs get the
 *     reviewed tree, not whatever `main` or a moved tag points at;
 *   - security-reviews/<name>.md has `## <version>` with `Verdict: pass`.
 * Merges must be merge commits (no squash or rebase) so a pinned sha stays
 * reachable from main. Exit 0 = pass, 1 = named failures.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CANONICAL_URL = "https://github.com/Oneirico/claude-plugins.git";

const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const gitOk = (root, args) => { try { git(root, args); return true; } catch { return false; } };

export function semverGreater(a, b) {
  const pa = String(a).split(/[.-]/).slice(0, 3).map(Number);
  const pb = String(b).split(/[.-]/).slice(0, 3).map(Number);
  if ([...pa, ...pb].some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

/** The `## <version>` section of a Markdown file, or null. */
export function section(text, version) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${version}` || l.startsWith(`## ${version} `));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

export function changedPlugins(root, base) {
  const files = git(root, ["diff", "--name-only", `${base}...HEAD`]).split("\n").filter(Boolean);
  return [...new Set(files.map((f) => /^plugins\/([^/]+)\//.exec(f)?.[1]).filter(Boolean))];
}

const manifestAt = (root, rev, name) => JSON.parse(git(root, ["show", `${rev}:plugins/${name}/.claude-plugin/plugin.json`]));

/** A changed plugin moved its version forward and says what changed. */
export function checkChange(root, base, name) {
  const dir = path.join(root, "plugins", name);
  if (!existsSync(dir)) return [];
  const problems = [];
  const version = manifestAt(root, "HEAD", name).version;
  let before = null;
  try { before = manifestAt(root, base, name).version; } catch { /* new plugin */ }
  if (before !== null && !semverGreater(version, before)) problems.push(`${name}: changed but its version did not move forward (${before} → ${version}).`);
  const changelog = existsSync(path.join(dir, "CHANGELOG.md")) ? readFileSync(path.join(dir, "CHANGELOG.md"), "utf8") : "";
  if (!section(changelog, version)) problems.push(`${name}: CHANGELOG.md has no "## ${version}" section.`);
  return problems;
}

/** A marketplace entry installs exactly the reviewed release. */
export function checkEntry(root, entry) {
  const { name, source: s = {} } = entry;
  const where = `marketplace entry ${name}`;
  if (s.source !== "git-subdir" || s.url !== CANONICAL_URL || s.path !== `plugins/${name}`) {
    return [`${where}: must be git-subdir from ${CANONICAL_URL}, path plugins/${name}.`];
  }
  if (!/^[0-9a-f]{40}$/.test(s.sha ?? "")) return [`${where}: must pin a full 40-hex commit sha.`];
  if (!gitOk(root, ["merge-base", "--is-ancestor", s.sha, "HEAD"])) return [`${where}: sha ${s.sha} is not in this history.`];
  const problems = [];
  const version = manifestAt(root, s.sha, name).version;
  if (s.ref !== `${name}-v${version}`) problems.push(`${where}: ref must be ${name}-v${version}, the version at its sha.`);
  if (!gitOk(root, ["diff", "--quiet", s.sha, "HEAD", "--", `plugins/${name}`])) {
    problems.push(`${where}: plugins/${name}/ at HEAD differs from its pinned sha — re-pin to the commit that holds the reviewed tree.`);
  }
  const reviewFile = path.join(root, "security-reviews", `${name}.md`);
  const review = section(existsSync(reviewFile) ? readFileSync(reviewFile, "utf8") : "", version);
  if (!review) problems.push(`${where}: security-reviews/${name}.md has no "## ${version}" section — every release gets a Security Officer review.`);
  else if (!/^Verdict:\s*pass\b/im.test(review)) problems.push(`${where}: the ${version} Security Officer record does not say "Verdict: pass".`);
  return problems;
}

export function gate(root, base) {
  const market = JSON.parse(readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
  const listed = new Set((market.plugins ?? []).map((p) => p.name));
  const unlisted = changedPlugins(root, base).filter((n) => existsSync(path.join(root, "plugins", n)) && !listed.has(n));
  return [
    ...changedPlugins(root, base).flatMap((name) => checkChange(root, base, name)),
    ...(market.plugins ?? []).flatMap((entry) => checkEntry(root, entry)),
    ...unlisted.map((n) => `${n}: changed, but has no marketplace entry.`),
  ];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const base = process.argv[2];
  if (!base) { process.stderr.write("usage: release-gate.mjs <base-ref>\n"); process.exit(1); }
  const problems = gate(process.cwd(), base);
  for (const p of problems) process.stderr.write(`release gate: ${p}\n`);
  if (problems.length) process.exit(1);
  process.stdout.write("release gate OK\n");
}
