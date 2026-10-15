#!/usr/bin/env node
/**
 * Release gate — every change to a plugin is a release, and every release is
 * reviewed (ADR-0004 in Oneirico/ProjectTemplate).
 *
 *   node scripts/release-gate.mjs <base-ref>
 *
 * For each plugins/<name>/ that changed since <base-ref>:
 *   - its plugin.json version moved forward (semver);
 *   - CHANGELOG.md has a `## <version>` section;
 *   - SECURITY-REVIEWS.md has a `## <version>` section with `Verdict: pass`;
 *   - the marketplace entry installs it from tag `<name>-v<version>`.
 * Projects pin that version; an unbumped change would reach them unreviewed
 * under a version they already accepted. Exit 0 = pass, 1 = named failures.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

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

export function checkPlugin(root, base, name) {
  const dir = path.join(root, "plugins", name);
  if (!existsSync(dir)) return []; // removed: the marketplace check below still applies to the rest
  const problems = [];
  const version = JSON.parse(readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8")).version;
  let before = null;
  try { before = JSON.parse(git(root, ["show", `${base}:plugins/${name}/.claude-plugin/plugin.json`])).version; } catch { /* new plugin */ }
  if (before !== null && !semverGreater(version, before)) problems.push(`${name}: changed but its version did not move forward (${before} → ${version}).`);
  const read = (f) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), "utf8") : "");
  if (!section(read("CHANGELOG.md"), version)) problems.push(`${name}: CHANGELOG.md has no "## ${version}" section.`);
  const review = section(read("SECURITY-REVIEWS.md"), version);
  if (!review) problems.push(`${name}: SECURITY-REVIEWS.md has no "## ${version}" section — every release gets a Security Officer review.`);
  else if (!/^Verdict:\s*pass\b/im.test(review)) problems.push(`${name}: the ${version} Security Officer record does not say "Verdict: pass".`);
  const market = JSON.parse(readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
  const entry = market.plugins?.find((p) => p.name === name);
  if (!entry) problems.push(`${name}: no marketplace entry.`);
  else if (entry.source?.ref !== `${name}-v${version}` || entry.source?.path !== `plugins/${name}`) {
    problems.push(`${name}: the marketplace entry must install plugins/${name} from tag ${name}-v${version}.`);
  }
  return problems;
}

export function gate(root, base) {
  return changedPlugins(root, base).flatMap((name) => checkPlugin(root, base, name));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const base = process.argv[2];
  if (!base) { process.stderr.write("usage: release-gate.mjs <base-ref>\n"); process.exit(1); }
  const problems = gate(process.cwd(), base);
  for (const p of problems) process.stderr.write(`release gate: ${p}\n`);
  if (problems.length) process.exit(1);
  process.stdout.write("release gate OK\n");
}
