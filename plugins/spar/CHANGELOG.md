# Changelog

## 1.0.0

First release as a plugin. Moved from Oneirico/ProjectTemplate (#22, #24),
merge commit 6897553.

- `spar check|send|status` from the plugin's `bin/`, rewritten by the
  plugin's Bash hook to run the plugin's own script by absolute path, in the
  session's project, with a cleared environment.
- The project root comes from the working directory's repository, and the
  ledger from its main checkout. Git is queried with every `GIT_*` variable
  removed. **Fixes:** in the template copy, `GIT_DIR`/`GIT_COMMON_DIR` in
  front of `send` moved the ledger and the `.env` search.
- Config is read from the committed `HEAD`. `send` refuses an uncommitted
  change.
- Projects pin the plugin version in `dev/spar.config.json`
  (`plugin.version`). `send` refuses a mismatch; `check` and `status` warn.
- `send` refuses while a settings file allow-lists it or sets
  `bypassPermissions`. The hook denies `send` in bypass mode.
- A file hook denies agent writes to:
  - the plugin cache;
  - user and local settings;
  - shell startup files;
  - `dev/spar.config.json` in every checkout.
- The outbound guard, providers, budget and topic handling are unchanged
  from #24.
