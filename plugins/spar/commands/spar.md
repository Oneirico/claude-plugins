---
description: Spar a design with an outside model — brief, reply, answer, until one agreed plan
argument-hint: <topic> [one-line question]
allowed-tools: Bash(mkdir:*), Read, Write, Edit, Glob, Grep
---

Spar a plan with an outside model. The whole practice — when to spar and when
not to, privacy, cost — is the project's `docs/playbook/design-sparring.md`.
Read it first; this is the order of work.

Run `spar` exactly as written below, on its own, from the project — no `cd`,
no prefix, no `&&`. The plugin's hook runs it by absolute path and refuses
any other form. Never run the plugin's scripts by path.

Topic: `$ARGUMENTS`

**The partner is a critic of plans, never a source of facts.** It gets the
brief, never the code. Verify every factual claim it makes before you rely on
it. A suggestion that changes scope goes to the owner, not into the plan.

1. **Open the topic.** `docs/sparring/<yyyy-mm-dd>-<topic>/` (today's date,
   lowercase, hyphenated). Run `spar status` and tell the
   owner the provider, model, month-to-date spend, and any warning — a
   version-pin mismatch or an uncommitted config means `send` will refuse
   until the owner fixes it.
2. **Write `round-1-brief.md`** in general terms, no code, no secrets, no
   customer or host data:
   - **Context** — the goal and the constraints, in a few sentences.
   - **Evidence and results** — as tables, with where each number came from.
   - **Options** — each with its cost and risk.
   - **Open questions** — what we do not know.
   - **Asks** — specific: rank the options, cut what is not needed, find the holes.
3. **Check it:** `spar check <brief>`. A refusal names the
   rule and line — rewrite the passage in general terms. Never work around the
   guard; if a refusal is wrong, tell the owner.
4. **Send it:** `spar send <topic-dir> --round N`. This
   crosses to an outside provider, so it asks the owner each time. Report the
   cost line it prints.
5. **Read `round-N-reply.md`.** Sort each point: adopt, reject (with the
   reason), verify (a factual claim — check it in the repo or the data, and
   say what you found), or owner (it changes scope).
6. **Answer in `round-(N+1)-brief.md`**: what you adopted, what you reject and
   why, what verification showed, and the revised plan. Check, send, repeat.
7. **Stop** when the reply says `VERDICT: AGREE` and you agree too, when the
   owner stops it, or at `maxRounds` (default 4; the script refuses past it).
8. **Write `agreement.md`**: the plan both sides sign, what was adopted from
   the partner, where we disagreed and why, and the open questions for the
   owner. Commit the topic folder with the work it informed.

Do not use it for facts, code review, or debugging. Do not pass `--model` to
a pricier model unless the owner asked for it on this topic.
