/**
 * Cost control for design sparring: prices from config, a worst-case estimate
 * refused BEFORE the send when it would pass the monthly budget, and the
 * actual cost appended to a ledger after.
 *
 * The ledger lives in the MAIN checkout's `.spar/` (git-ignored), not a
 * worktree's: worktrees come and go, and a budget that resets with each one is
 * no budget. Same reasoning as `.evidence/`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Conservative chars → tokens: ~4 for English, 3 to leave headroom. */
const CHARS_PER_TOKEN = 3;
const STALE_PRICE_DAYS = 90;

export class BudgetRefusal extends Error {}

export function priceFor(config, model) {
  const price = config.prices?.[model];
  if (!price || !(price.input >= 0) || !(price.output >= 0)) {
    throw new BudgetRefusal(`no price for model "${model}" in dev/spar.config.json — its cost cannot be bounded, so it is not sent. `
      + "The owner adds prices.<model> = { input, output } (USD per 1M tokens).");
  }
  return price;
}

const usd = (tokens, perMillion) => (tokens * perMillion) / 1e6;

export const worstCase = (requestChars, maxOutputTokens, price) =>
  usd(Math.ceil(requestChars / CHARS_PER_TOKEN), price.input) + usd(maxOutputTokens, price.output);

export const actualCost = ({ inputTokens, outputTokens }, price) =>
  usd(inputTokens, price.input) + usd(outputTokens, price.output);

export const monthOf = (date) => date.toISOString().slice(0, 7);

export function readLedger(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export const monthToDate = (entries, month) =>
  entries.filter((e) => String(e.at ?? "").startsWith(month)).reduce((sum, e) => sum + (Number(e.costUsd) || 0), 0);

/** Refuse when the month so far plus this send's worst case passes the budget. */
export function checkBudget({ spent, estimate, budget }) {
  if (!(budget > 0)) throw new BudgetRefusal("monthlyBudgetUsd is not set in dev/spar.config.json");
  if (spent + estimate > budget) {
    throw new BudgetRefusal(`monthly budget: $${spent.toFixed(2)} spent + up to $${estimate.toFixed(2)} for this send `
      + `would pass $${budget.toFixed(2)}. Not sent. The owner raises monthlyBudgetUsd or waits for next month.`);
  }
}

export function appendLedger(file, entry) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

/** `<main checkout>/.spar/ledger.jsonl`. No environment override: a
 *  variable that moved the ledger would reset the budget. */
export const ledgerPath = (main) => path.join(main, ".spar", "ledger.jsonl");

/** A warning when prices were last checked long ago, else null. */
export function priceAgeWarning(config, now = new Date()) {
  const checked = Date.parse(config.pricesCheckedOn ?? "");
  if (Number.isNaN(checked)) return "pricesCheckedOn is missing — cost estimates may be wrong.";
  const days = Math.floor((now.getTime() - checked) / 86_400_000);
  return days > STALE_PRICE_DAYS ? `prices were last checked ${days} days ago — the owner re-checks them.` : null;
}
