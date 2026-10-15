# Security Officer reviews — spar

One section per released version, **written by the owner** (agents are
denied edits to this file). The release gate refuses a version without a
section here that says `Verdict: pass`.

Each section records:

- the date;
- the reviewer;
- the PR;
- what was reviewed (the trust boundary of ADR-0003 and ADR-0004);
- the findings and how each was resolved;
- the verdict, as `Verdict: pass` or `Verdict: blocked`.

<!-- Owner: add "## 1.0.0" here from the Security Officer's review in the 1.0.0 PR. -->
## 1.0.0

- Date: 2026-10-15
- Reviewer: Security Officer (Claude Code subagent), for the owner
- PR: Oneirico/claude-plugins feature/spar-1.0.0 (commits dc220bb, ed491f8, 432db78; pinned 432db78); template Oneirico/ProjectTemplate#27 (issue #26)
- Reviewed: the trust boundary of ADR-0003 and ADR-0004 —
  - the Bash hook's plain-form rewrite (quoting, cleared environment, checkout check, fail-closed);
  - the file hook (canonical paths, case, links, every path field);
  - pin and config at HEAD;
  - allow-rule detection;
  - the release gate and the marketplace pin;
  - the template settings.
- Findings (8), all resolved in ed491f8/432db78:
  1. Config key names could pass NODE_OPTIONS/PATH/DYLD_* into the cleared environment. Now only *_KEY/*_TOKEN names, never runtime variables.
  2. The marketplace pinned a tag only, and the gate skipped changes to marketplace.json alone. Now a 40-hex sha plus the tag and the canonical URL; every entry is checked on every run, and the tree at the sha must equal HEAD's.
  3. Template allow rules for `spar check|status` approved whatever `spar` is on PATH if the plugin was inactive. Removed.
  4. allowsSend missed leading/infix wildcards. Rules are now compiled as globs and tested against the plain form and the rewrite.
  5. The README overstated the bypass-mode deny. Reworded.
  6. An empty file_path let notebook_path skip the file guard. Every path field is now checked.
  7. CI ran the PR's own gate. It now runs from the base branch.
  8. The send prompt didn't name the checkout. It now names the checkout and branch.
- Residual (accepted):
  - shell edits bypass the file hooks; agents hold the owner's gh token; the pin is not tamper-evidence;
  - `Bash(node:*)`-style rules aren't flagged;
  - Claude Code applying `updatedInput` and honouring `sha` on git-subdir is unverified — the owner smoke-tests before bumping a project pin;
  - merge commits only, so pinned shas stay reachable.

Verdict: pass