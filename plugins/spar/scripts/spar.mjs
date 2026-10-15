#!/usr/bin/env node
/**
 * Design sparring with an outside model — ONE round per invocation.
 *
 *   spar check <brief.md>…                                   guard only, offline
 *   spar send docs/sparring/<date>-<topic> --round N [--provider p] [--model m]
 *   spar status                                              budget, pin, month to date
 *
 * Run from the project: `spar` is the plugin's bin/, and the plugin's Bash
 * hook rewrites it to this file by absolute path, in the session's project,
 * with a cleared environment (hooks/guard-bash.mjs).
 *
 * The partner is a critic of plans, never a source of facts, and it gets the
 * brief, never the code. Every send passes the outbound guard
 * (spar-lib/guard.mjs) and the budget (spar-lib/budget.mjs) first; neither has
 * an override. Config: the project's committed dev/spar.config.json
 * (owner-only), which also pins the plugin version it accepts. How and when:
 * the project's docs/playbook/design-sparring.md.
 *
 * `check` and `status` run without a prompt. `send` crosses the trust
 * boundary, so every send is a permission prompt, and it refuses while any
 * settings file would skip that prompt.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { actualCost, appendLedger, BudgetRefusal, checkBudget, ledgerPath, monthOf, monthToDate, priceAgeWarning, priceFor, readLedger, worstCase } from "./spar-lib/budget.mjs";
import { checkOutbound, formatRefusal, indexCodeLines } from "./spar-lib/guard.mjs";
import { errorMessage, providerFor, verdictOf } from "./spar-lib/providers.mjs";
import { loadConfig, pinProblem, pluginVersion, ProjectRefusal, roots, sendAllowRules, settingsFiles } from "./spar-lib/project.mjs";
import { appendSend, loadAllKeys, loadKey, readPlain, readRounds, resolveTopic, TopicRefusal, writeReply } from "./spar-lib/topic.mjs";

const TIMEOUT_MS = 15 * 60 * 1000;

export class GuardRefusal extends Error {}

/**
 * The project, its trusted config and the warnings a run prints. Root and
 * ledger come from the working directory's repository (spar-lib/project.mjs),
 * config from its committed HEAD. Tests inject `root` through `deps`.
 */
export function project({ root: rootDep, cwd } = {}) {
  const where = roots({ root: rootDep, cwd });
  const { config, dirty } = loadConfig(where);
  const warnings = [];
  if (dirty) warnings.push("dev/spar.config.json differs from the committed copy — the committed copy is what applies; send refuses until it is committed.");
  if (!where.injected) {
    const pin = pinProblem(config);
    if (pin) warnings.push(pin);
  }
  return { ...where, config, dirty, warnings };
}

/** What `send` refuses on that `check` and `status` only report. */
function refuseUntrusted(p, home) {
  if (p.dirty) throw new TopicRefusal(p.warnings[0]);
  if (p.injected) return;
  const pin = pinProblem(p.config);
  if (pin) throw new TopicRefusal(pin);
  const rules = sendAllowRules(settingsFiles(p, home));
  if (rules.length) {
    throw new TopicRefusal(`a settings file lets spar send run without a prompt, and the prompt is the boundary (ADR-0003). The owner removes:\n  ${rules.join("\n  ")}`);
  }
}

/** Provider settings for this send: config, then the per-topic flags. */
function settingsFor(config, flags) {
  const provider = flags.provider ?? config.provider;
  const base = Object.hasOwn(config.providers ?? {}, provider) ? config.providers[provider] : null;
  if (!base) throw new TopicRefusal(`provider "${provider}" is not configured in dev/spar.config.json`);
  providerFor(provider);
  return { provider, ...base, model: flags.model ?? base.model };
}

/**
 * The owner has confirmed this provider's data-retention settings for the
 * key's account and recorded where (an ADR, a date). Until then nothing is
 * sent — a stated rule nothing checks is not a gate.
 */
function requireRetention(s) {
  if (typeof s.retentionConfirmed !== "string" || !s.retentionConfirmed.trim()) {
    throw new TopicRefusal(`providers.${s.provider}.retentionConfirmed is empty in dev/spar.config.json. The owner confirms the `
      + "provider's data-retention settings for this account and records where (ADR, date) — docs/playbook/design-sparring.md.");
  }
}

/** Every value of every configured key — provider keys and the project's
 *  `guard.extraKeyEnvs` — so the guard refuses any of them in a brief. */
function knownKeys(config, env, rootList) {
  const g = config.guard ?? {};
  for (const field of ["extraKeyEnvs", "keyEnvFiles"]) {
    if (g[field] !== undefined && !(Array.isArray(g[field]) && g[field].every((v) => typeof v === "string"))) {
      throw new TopicRefusal(`guard.${field} in dev/spar.config.json must be a list of strings`);
    }
  }
  const names = [...Object.values(config.providers ?? {}).map((p) => p.keyEnv), ...(g.extraKeyEnvs ?? [])];
  return [...new Set(names)].filter(Boolean).flatMap((n) => loadAllKeys(n, env, rootList, g.keyEnvFiles ?? []));
}

function guardOrRefuse(texts, config, root, secretValues) {
  const codeLines = indexCodeLines(root, config.guard?.codePaths);
  const refusals = checkOutbound(texts, config, { codeLines, secretValues });
  if (refusals.length) {
    throw new GuardRefusal(`outbound guard refused — nothing was sent. The owner edits the brief:\n${refusals.map(formatRefusal).join("\n")}`);
  }
}

async function post(fetchImpl, request) {
  const res = await fetchImpl(request.url, {
    method: "POST", headers: request.headers, body: JSON.stringify(request.body), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`provider refused: ${errorMessage(res.status, json)}`);
  return json;
}

/**
 * Send one round. Everything the outside world touches comes in through
 * `deps`, so tests run it end to end against a mocked fetch.
 */
export async function send(flags, { env = process.env, fetchImpl = fetch, now = () => new Date(), log = console.log, root: rootDep, cwd, home, ledgerFile } = {}) {
  const proj = project({ root: rootDep, cwd });
  refuseUntrusted(proj, home);
  const { root, main, config } = proj;
  const round = Number(flags.round);
  if (round > config.maxRounds) throw new TopicRefusal(`round ${round} passes maxRounds (${config.maxRounds}) — close the topic with agreement.md and take what is open to the owner.`);
  const dir = resolveTopic(root, flags.topic);
  const s = settingsFor(config, flags);
  requireRetention(s);
  const { turns, texts } = readRounds(dir, round);

  const key = loadKey(s.keyEnv, env, [root, main]);
  if (!key) throw new TopicRefusal(`${s.keyEnv} is not set (environment or .env). The owner adds it; see .env.example.`);
  guardOrRefuse(texts, config, root, knownKeys(config, env, [root, main]));

  const price = priceFor(config, s.model);
  const requestChars = texts.reduce((n, t) => n + t.text.length, 0);
  const ledger = ledgerFile ?? ledgerPath(main);
  const month = monthOf(now());
  const spent = monthToDate(readLedger(ledger), month);
  checkBudget({ spent, estimate: worstCase(requestChars, s.maxOutputTokens, price), budget: config.monthlyBudgetUsd });

  const p = providerFor(s.provider);
  const result = p.parse(await post(fetchImpl, p.build({ ...s, key }, turns)));

  const at = now().toISOString();
  const costUsd = actualCost(result, price);
  const verdict = verdictOf(result.text);
  const briefSha256 = createHash("sha256").update(texts.at(-1).text).digest("hex");
  const entry = { at, topic: path.basename(dir), round, provider: s.provider, model: s.model, effort: s.effort, briefSha256, requestChars,
    inputTokens: result.inputTokens, outputTokens: result.outputTokens, reasoningTokens: result.reasoningTokens,
    costUsd: Number(costUsd.toFixed(6)), status: result.status, verdict };
  // A billed answer is recorded even when it carries no text: spend the
  // ledger never sees is spend the budget cannot refuse.
  appendSend(dir, entry);
  appendLedger(ledger, entry);
  if (!result.text) throw new Error(`provider returned no text (status: ${result.status}); its cost was recorded`);
  writeReply(dir, round, result.text, { ...s, at });

  log(`round ${round} → ${path.relative(root, dir)}/round-${round}-reply.md (${result.status}, verdict ${verdict})`);
  log(`cost: $${costUsd.toFixed(4)} (${result.inputTokens} in / ${result.outputTokens} out, ${result.reasoningTokens} reasoning) · `
    + `month to date $${(spent + costUsd).toFixed(2)} of $${config.monthlyBudgetUsd}`);
  return entry;
}

/** Briefs only: `check` reads nothing outside docs/sparring/, so it cannot be
 *  used to probe `.env` or any other file for which rules it trips. */
function briefPath(root, f) {
  const abs = path.resolve(root, f);
  const rel = path.relative(path.join(root, "docs", "sparring"), abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || !abs.endsWith(".md")) {
    throw new TopicRefusal(`${f}: check reads only .md briefs under docs/sparring/`);
  }
  // A link anywhere on the way (the file, its topic folder) is refused too.
  const real = realpathSync(abs);
  if (real !== path.join(realpathSync(root), "docs", "sparring", rel)) {
    throw new TopicRefusal(`${f} is, or sits under, a symbolic link — briefs must be plain files in docs/sparring/.`);
  }
  return abs;
}

export function check(files, { env = process.env, log = console.log, root: rootDep, cwd } = {}) {
  const { root, main, config, warnings } = project({ root: rootDep, cwd });
  for (const w of warnings) log(`warning: ${w}`);
  if (!files.length) throw new TopicRefusal("name one or more brief files to check");
  const texts = files.map((f) => briefPath(root, f)).map((abs) => ({ name: path.relative(root, abs), text: readPlain(abs), brief: true }));
  guardOrRefuse(texts, config, root, knownKeys(config, env, [root, main]));
  log(`outbound guard: ${files.length} file(s) clear.`);
}

export function status({ now = () => new Date(), log = console.log, root: rootDep, cwd, ledgerFile } = {}) {
  const { main, config, warnings, injected } = project({ root: rootDep, cwd });
  if (!injected) log(`plugin spar ${pluginVersion()} · project pins ${config.plugin?.version ?? "nothing"}`);
  const entries = readLedger(ledgerFile ?? ledgerPath(main));
  const month = monthOf(now());
  const spent = monthToDate(entries, month);
  const s = config.providers?.[config.provider] ?? {};
  log(`provider ${config.provider} · model ${s.model} · effort ${s.effort} · max rounds ${config.maxRounds}`);
  log(`retention confirmed: ${s.retentionConfirmed || "NO — send is refused until the owner records it"}`);
  log(`${month}: $${spent.toFixed(2)} of $${config.monthlyBudgetUsd} (${entries.filter((e) => String(e.at).startsWith(month)).length} sends)`);
  const warning = priceAgeWarning(config, now());
  for (const w of [...warnings, warning].filter(Boolean)) log(`warning: ${w}`);
}

/** Strict parsing: an unknown flag — `--force` included — is an error, not ignored. */
export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: { round: { type: "string" }, provider: { type: "string" }, model: { type: "string" } },
  });
  const [command, ...rest] = positionals;
  return { command, rest, values };
}

export async function main(argv, deps = {}) {
  const { command, rest, values } = parseCli(argv);
  if (command === "check") return check(rest, deps);
  if (command === "status") return status(deps);
  if (command === "send") return send({ ...values, topic: rest[0] }, deps);
  throw new TopicRefusal("usage: spar check <brief>… | send <topic-dir> --round N [--provider p] [--model m] | status");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((err) => {
    const known = err instanceof GuardRefusal || err instanceof BudgetRefusal || err instanceof TopicRefusal || err instanceof ProjectRefusal || err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION";
    process.stderr.write(`spar: ${err.message}\n`);
    process.exit(known ? 1 : 2);
  });
}
