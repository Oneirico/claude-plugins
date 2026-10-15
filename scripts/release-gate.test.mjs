import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CANONICAL_URL, gate, section, semverGreater } from "./release-gate.mjs";

/** A repo whose main holds spar 1.0.0, released the way the README says:
 *  the plugin commit, then the marketplace pinned to it, then the review. */
function repo() {
  const root = mkdtempSync(path.join(tmpdir(), "release-gate-"));
  const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" }).trim();
  const put = (f, text) => { mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); writeFileSync(path.join(root, f), text); };
  const commit = () => { git("add", "."); git("commit", "-q", "-m", "c"); return git("rev-parse", "HEAD"); };
  const entry = (version, sha, over = {}) => ({ name: "spar", source: { source: "git-subdir", url: CANONICAL_URL, path: "plugins/spar", ref: `spar-v${version}`, sha, ...over } });
  const market = (...entries) => put(".claude-plugin/marketplace.json", JSON.stringify({ plugins: entries }));
  const review = (version, verdict = "pass") => put("security-reviews/spar.md", `# Reviews\n\n## ${version}\n\nVerdict: ${verdict}\n`);
  /** Plugin commit, marketplace pin, review — returns the plugin sha. */
  const release = (version, { code = `// ${version}\n`, changelog = true } = {}) => {
    put("plugins/spar/.claude-plugin/plugin.json", JSON.stringify({ name: "spar", version }));
    put("plugins/spar/CHANGELOG.md", changelog ? `# Changelog\n\n## ${version}\n\n- x\n` : "# Changelog\n");
    put("plugins/spar/scripts/spar.mjs", code);
    const sha = commit();
    market(entry(version, sha));
    review(version);
    commit();
    return sha;
  };
  git("init", "-q", "-b", "main");
  release("1.0.0");
  git("branch", "base");
  return { root, put, commit, release, market, entry, review };
}

test("semver and sections", () => {
  assert.ok(semverGreater("1.0.1", "1.0.0") && semverGreater("2.0.0", "1.9.9") && !semverGreater("1.0.0", "1.0.0") && !semverGreater("0.9.0", "1.0.0"));
  assert.match(section("## 1.1.0\nVerdict: pass\n## 1.0.0\nold", "1.1.0"), /Verdict: pass/);
  assert.equal(section("## 1.0.0\n", "1.1.0"), null);
});

test("a full release passes", () => {
  const r = repo();
  r.release("1.1.0");
  assert.deepEqual(gate(r.root, "base"), []);
});

test("a code change without a version bump is refused, and so is one the pin does not cover", () => {
  const r = repo();
  r.put("plugins/spar/scripts/spar.mjs", "// changed\n");
  r.commit();
  const problems = gate(r.root, "base").join("\n");
  assert.match(problems, /did not move forward/);
  assert.match(problems, /differs from its pinned sha/);
});

test("a missing review, a blocked verdict or a missing changelog fails", () => {
  for (const [setup, re] of [
    [(r) => { r.release("1.1.0"); r.put("security-reviews/spar.md", "# Reviews\n"); r.commit(); }, /no "## 1\.1\.0" section/],
    [(r) => { r.release("1.1.0"); r.review("1.1.0", "blocked"); r.commit(); }, /does not say "Verdict: pass"/],
    [(r) => r.release("1.1.0", { changelog: false }), /CHANGELOG/],
  ]) {
    const r = repo();
    setup(r);
    assert.match(gate(r.root, "base").join("\n"), re);
  }
});

test("a marketplace-only change is checked: fork URL, short or foreign sha, wrong ref", () => {
  const forkSha = (() => { const r = repo(); return r.release("9.9.9"); })();
  for (const [over, re] of [
    [{ url: "https://github.com/someone/fork.git" }, /must be git-subdir from/],
    [{ sha: "abc123" }, /full 40-hex/],
    [{ sha: forkSha }, /not in this history/],
    [{ ref: "main" }, /ref must be spar-v1\.0\.0/],
    [{ path: "plugins/other" }, /path plugins\/spar/],
  ]) {
    const r = repo();
    const pinned = JSON.parse(execFileSync("git", ["show", "HEAD:.claude-plugin/marketplace.json"], { cwd: r.root, encoding: "utf8" })).plugins[0].source.sha;
    r.market(r.entry("1.0.0", pinned, over));
    r.commit();
    assert.match(gate(r.root, "base").join("\n"), re, JSON.stringify(over));
  }
});

test("re-pinning to an older release's sha is refused: the tree differs", () => {
  const r = repo();
  const old = JSON.parse(execFileSync("git", ["show", "HEAD:.claude-plugin/marketplace.json"], { cwd: r.root, encoding: "utf8" })).plugins[0].source.sha;
  r.release("1.1.0");
  r.market(r.entry("1.0.0", old));
  r.commit();
  assert.match(gate(r.root, "base").join("\n"), /differs from its pinned sha/);
});

test("changes outside plugins/ with an intact marketplace pass", () => {
  const r = repo();
  r.put("README.md", "x\n");
  r.commit();
  assert.deepEqual(gate(r.root, "base"), []);
});
