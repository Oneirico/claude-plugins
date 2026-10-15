# Oneirico Claude Code plugins

A Claude Code plugin marketplace. MIT licensed.

| Plugin | What it does |
|--------|--------------|
| [`spar`](plugins/spar/) | Spar a design with an outside model (OpenAI or Gemini) through one guarded, budgeted, tool-free door. |

## Install

In a project's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "oneirico": { "source": { "source": "github", "repo": "Oneirico/claude-plugins" }, "autoUpdate": false }
  },
  "enabledPlugins": { "spar@oneirico": true }
}
```

Then trust the folder and install the plugin it names. With the CLI:

```bash
claude plugin marketplace add Oneirico/claude-plugins
```

```bash
claude plugin install spar@oneirico
```

Each plugin's README says what the project itself must provide. `spar` needs
a committed `dev/spar.config.json` that **pins the plugin version** the
project accepts.

## How releases work

Changing a plugin is releasing it. The plugins guard what leaves a project,
so releases are gated:

1. A PR changes `plugins/<name>/`. Agents open these as drafts only.
2. The same PR bumps the version in `plugins/<name>/.claude-plugin/plugin.json`
   and adds a `## <version>` section to its `CHANGELOG.md`, in one commit.
   A second commit pins the marketplace entry to that commit: its full `sha`
   and the tag name `<name>-v<version>`.
3. A Security Officer reviews the release. The **owner** records the review
   in `security-reviews/<name>.md` under `## <version>`, ending with
   `Verdict: pass`. The record lives outside the plugin, so adding it does
   not change the pinned tree.
4. CI runs the tests and the release gate, taken from the base branch so a PR
   cannot weaken the gate that checks it. The gate refuses:
   - a plugin change with no version bump or changelog;
   - a marketplace entry that is not this repo, not a full sha already in
     the history, or whose pinned tree differs from `HEAD`'s;
   - a release with no `Verdict: pass` record.
5. The owner merges **with a merge commit** (no squash or rebase, so the
   pinned sha stays on `main`), then tags that sha `<name>-v<version>`.
   Installs come from the pinned sha, never from `main`.
6. Each project gets the release only when its owner bumps the pin in that
   project's config, after reading the changelog and the review record.

Decision record: ADR-0004 in Oneirico/ProjectTemplate (`docs/arch/`).

### Repository settings (owner)

The owner applies these in the GitHub settings. Agents must not change them.

- **Ruleset on `main`:** require a pull request with 1 approval and Code
  Owner review; require the `test` and `release-gate` checks; allow merge
  commits only; block force pushes and deletion; **no bypass actors**.
- **Tag ruleset on `*-v*`:** only the owner may create them; block updates
  and deletion, so a release tag never moves.
- **Visibility:** public.

## Develop

```bash
npm test
```

```bash
npm run validate
```

Tests never call a provider: every send in them is a mocked fetch.
