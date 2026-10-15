import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { gate, section, semverGreater } from "./release-gate.mjs";

function repo() {
  const root = mkdtempSync(path.join(tmpdir(), "release-gate-"));
  const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root, stdio: "ignore" });
  const put = (f, text) => { mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); writeFileSync(path.join(root, f), text); };
  const release = (version, { review = "Verdict: pass", ref = `spar-v${version}`, changelog = true } = {}) => {
    put("plugins/spar/.claude-plugin/plugin.json", JSON.stringify({ name: "spar", version }));
    put("plugins/spar/CHANGELOG.md", changelog ? `# Changelog\n\n## ${version}\n\n- x\n` : "# Changelog\n");
    put("plugins/spar/SECURITY-REVIEWS.md", `# Reviews\n\n## ${version}\n\n${review}\n`);
    put(".claude-plugin/marketplace.json", JSON.stringify({ plugins: [{ name: "spar", source: { source: "git-subdir", path: "plugins/spar", ref } }] }));
  };
  git("init", "-q", "-b", "main");
  release("1.0.0");
  put("plugins/spar/scripts/spar.mjs", "// v1\n");
  git("add", ".");
  git("commit", "-q", "-m", "1.0.0");
  return { root, put, release, commit: () => { git("add", "."); git("commit", "-q", "-m", "c"); } };
}

test("semver and sections", () => {
  assert.ok(semverGreater("1.0.1", "1.0.0") && semverGreater("2.0.0", "1.9.9") && !semverGreater("1.0.0", "1.0.0") && !semverGreater("0.9.0", "1.0.0"));
  assert.match(section("## 1.1.0\nVerdict: pass\n## 1.0.0\nold", "1.1.0"), /Verdict: pass/);
  assert.equal(section("## 1.0.0\n", "1.1.0"), null);
});

test("a code change without a version bump is refused", () => {
  const r = repo();
  r.put("plugins/spar/scripts/spar.mjs", "// changed\n");
  r.commit();
  assert.match(gate(r.root, "main~1").join("\n"), /did not move forward/);
});

test("a full release passes; a missing review, verdict, changelog or tag ref each fails", () => {
  const ok = repo();
  ok.release("1.1.0");
  ok.commit();
  assert.deepEqual(gate(ok.root, "main~1"), []);
  for (const [opts, re] of [[{ review: "" }, /does not say "Verdict: pass"/], [{ review: "Verdict: blocked" }, /does not say/],
    [{ changelog: false }, /CHANGELOG/], [{ ref: "main" }, /from tag spar-v1\.1\.0/]]) {
    const r = repo();
    r.release("1.1.0", opts);
    r.commit();
    assert.match(gate(r.root, "main~1").join("\n"), re);
  }
});

test("changes outside plugins/ need no release", () => {
  const r = repo();
  r.put("README.md", "x\n");
  r.commit();
  assert.deepEqual(gate(r.root, "main~1"), []);
});
