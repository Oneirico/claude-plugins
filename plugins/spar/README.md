# spar

Spar a design with an outside model, OpenAI by default or Gemini, before it
becomes an ADR or a spec. The partner criticises plans; it is never a source
of facts. It gets the brief and never the code.

```text
/spar:spar <topic> [one-line question]
```

The command writes a brief and checks it, then sends it, reads the reply,
answers, and repeats until both sides agree. Every send goes through one
script:

- **Brief text only.** A request carries no tools of any kind; a test walks
  every request body to check.
- **Outbound guard.** It refuses code, copied code lines, secrets, keys,
  personal and host data, sealed patterns, and oversize briefs. It is a
  best-effort filter, not a guarantee.
- **The permission prompt is the boundary.** Every `spar send` asks. Send
  refuses while any settings file would skip that prompt, and it is denied
  in bypass-permissions mode.
- **Budget.** A monthly cap, checked before every send against a ledger in
  the project's main checkout.
- **Retention.** Nothing is sent to a provider until the owner records that
  they confirmed its data-retention settings.
- **No override flag**, anywhere.

## What the project provides

| Path | Committed? | What |
|------|-----------|------|
| `dev/spar.config.json` | yes, **owner-only** | Provider, models, prices, budget, guard patterns, retention confirmation, and the **plugin pin** `"plugin": { "version": "1.0.0" }` |
| `docs/sparring/<date>-<topic>/` | yes | Briefs, replies, `sends.jsonl`, `agreement.md` |
| `.env` (`OPENAI_API_KEY`, `GEMINI_API_KEY`) | no | Keys. They travel in a header only and are never printed |
| `.spar/ledger.jsonl` (main checkout) | no | Month-to-date spend |

Only the **committed** config counts. A working copy that differs is
reported, and `send` refuses it.

## How it stays honest

- **`spar` runs only through the plugin's Bash hook.** The plain form
  `spar check|send|status …` is rewritten to an absolute call: the session
  project's checkout, a cleared environment, this plugin's own script. Any
  other form is denied: `cd … &&`, an environment prefix, chaining, or the
  script by path. `bin/spar` itself refuses to run, so if the hook is off,
  nothing runs.
- **Root and ledger come from git**, with every `GIT_*` variable removed.
  The environment cannot move them.
- **Version pin.** `send` refuses unless the project's pin equals the
  installed version. A new release reaches a project only when its owner
  bumps the pin.
- **The agent cannot widen the guard.** The plugin's file hook denies
  file-tool writes to:
  - the plugin cache;
  - user settings, and `.claude/settings.local.json` in every checkout;
  - shell startup files;
  - `dev/spar.config.json` in every checkout.

  It compares case-insensitively, after resolving links, and fails closed.

Edits made through the shell (`sed -i`, redirects) are not seen by a
file-tool hook. That is why the per-send prompt stays the boundary
(ADR-0003). **Approve a send only when the prompt shows the rewritten
absolute command.**

## Releases

See the [marketplace README](../../README.md#how-releases-work):
[CHANGELOG](CHANGELOG.md) · [Security Officer reviews](SECURITY-REVIEWS.md)
· [Migrating from the template's copies](MIGRATING.md).
