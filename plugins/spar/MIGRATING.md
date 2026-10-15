# Migrating a project from copied /spar files to the plugin

For projects that copied `/spar` from Oneirico/ProjectTemplate (#22, maybe
#24). Nilometer goes first: it has the #22 files and no `code-detect.mjs`,
so it gains #24's guard hardening in the same move. Do it as one PR with an
issue. The settings change is disclosed above the fold.

## 1. Owner: pin and commit the config

`dev/spar.config.json` is owner-only, so an agent cannot do this step.

```json
"plugin": { "version": "1.0.0" }
```

Commit it. The plugin reads only the committed config, and `send` refuses
while the working copy differs from it.

#24 added built-in floors for code paths and personal data. A project's own
`guard.codePaths`, `sealed` and `deny` lists still apply on top of them, so
keep them.

## 2. Settings (`.claude/settings.json`)

**Add:**

```json
"extraKnownMarketplaces": {
  "oneirico": { "source": { "source": "github", "repo": "Oneirico/claude-plugins" }, "autoUpdate": false }
},
"enabledPlugins": { "spar@oneirico": true }
```

**Add to `permissions.deny`:**

- `Edit(~/.claude/plugins/**)` and `Write(~/.claude/plugins/**)`
- `Edit(~/.claude/settings*.json)` and `Write(~/.claude/settings*.json)`
- `Edit(./.claude/settings.local.json)` and `Write(./.claude/settings.local.json)`

**Remove:**

- the allow rules for `node dev/scripts/spar.mjs check:*` and `node dev/scripts/spar.mjs status`;
- the deny rules for `dev/scripts/spar.mjs` and `dev/scripts/spar-lib/**`.

**Keep** the deny rules for `dev/spar.config.json`.

Do **not** allow-list any `spar` command. The hook decides, and an allow rule would also cover a look-alike `spar` if the hook ever did not run. `send` refuses while a
settings file does.

## 3. Remove the copies

- `.claude/commands/spar.md`
- `dev/scripts/spar.mjs`
- `dev/scripts/spar-lib/`
- `dev/scripts/spar*.test.mjs`

Agents are denied edits to these files, so the owner deletes them, or
approves the deletion at its prompt.

**In `.claude/hooks/guard-paths.mjs`:** drop the `dev/scripts/spar.mjs` and
`spar-lib/` lines, and keep the `dev/spar.config.json` line. The project's
own guard then still protects the config if the plugin is ever disabled.

**In the project's own checks**, drop any references to the removed files:
- the code-size baseline;
- suite lists;
- `test:scripts` globs.

## 4. Docs

In the playbook (`design-sparring.md`), `AGENTS.md` and `CLAUDE.md`:

- Change `node dev/scripts/spar.mjs …` to `spar …`.
- Change the command to `/spar:spar`.
- Say that the plugin is pinned in `dev/spar.config.json`.

In the project's design-sparring ADR (Nilometer: ADR-0009), add an
"amended by" note pointing at ADR-0004 in Oneirico/ProjectTemplate. The guard
code now lives in the plugin, and releases are the owner's.

## 5. Each person, once per machine

Trust the folder, then run:

```bash
claude plugin marketplace add Oneirico/claude-plugins
```

```bash
claude plugin install spar@oneirico
```

## 6. Verify (no real API call)

1. Run `spar status`. It should print `plugin spar 1.0.0 · project pins 1.0.0`,
   and no warning about the pin or the config.
2. Run `spar check docs/sparring/<a topic>/round-1-brief.md`. It should
   report the brief clear, or refuse with a named rule.
3. Ask the agent to edit `dev/spar.config.json`, and separately to write
   `.claude/settings.local.json`. Both should be blocked.
4. Run `cd docs && spar status`. It should be denied: only the plain form
   runs.

The first real `send` is the owner's to approve, at its prompt. Approve it
only if the prompt shows `builtin cd -- '<checkout>' && command
/usr/bin/env -i … <node> '…/plugins/cache/oneirico/spar/1.0.0/scripts/spar.mjs' send …`.

## Later releases

A new release changes nothing in a project until its owner:

1. reads the plugin's `CHANGELOG.md` and the release's section in
   `security-reviews/spar.md`;
2. updates the installed plugin with `claude plugin update spar@oneirico`;
3. bumps `plugin.version` in `dev/spar.config.json` and commits it.
