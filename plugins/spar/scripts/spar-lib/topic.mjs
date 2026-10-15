/**
 * A sparring topic on disk: `docs/sparring/<yyyy-mm-dd>-<topic>/` holding
 * `round-N-brief.md`, `round-N-reply.md`, `sends.jsonl` and `agreement.md`.
 *
 * Only a folder of that shape can be sent from. That is part of the guard: the
 * script cannot be pointed at `modules/` or any other file, so what it can
 * send is limited to briefs written for the partner.
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import path from "node:path";

export const TOPIC_NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class TopicRefusal extends Error {}

export const briefFile = (dir, n) => path.join(dir, `round-${n}-brief.md`);
export const replyFile = (dir, n) => path.join(dir, `round-${n}-reply.md`);

/** Open without following a link (O_NOFOLLOW): the check and the open are
 *  one step, so a link swapped in between cannot be followed. */
function openPlain(file, flags) {
  try {
    return openSync(file, flags | constants.O_NOFOLLOW, 0o644);
  } catch (err) {
    if (err.code === "ELOOP" || err.code === "EMLINK") throw new TopicRefusal(`${path.basename(file)} is a symbolic link — topic files must be plain files.`);
    throw err;
  }
}

/**
 * Read a topic file only when it is a plain file: not a link, and not a hard
 * link to some other file. Either would carry another file's content — a
 * sealed set, a `.env` — past the guard, whose patterns match text, not where
 * the text came from.
 */
export function readPlain(file) {
  const fd = openPlain(file, constants.O_RDONLY);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new TopicRefusal(`${path.basename(file)} is not a plain file`);
    if (st.nlink > 1) throw new TopicRefusal(`${path.basename(file)} is a hard link — topic files must be plain files.`);
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

/** Write a topic file without following a link — a planted link, dangling or
 *  not, would otherwise send the reply or the log somewhere else. */
function writePlain(file, text, flags) {
  const fd = openPlain(file, constants.O_WRONLY | constants.O_CREAT | flags);
  try { writeSync(fd, text); } finally { closeSync(fd); }
}

/** The topic dir, resolved and confirmed to sit directly under docs/sparring/. */
export function resolveTopic(root, arg) {
  if (!arg) throw new TopicRefusal("name the topic folder: docs/sparring/<yyyy-mm-dd>-<topic>");
  const dir = path.resolve(root, arg);
  const parent = path.join(path.resolve(root), "docs", "sparring");
  if (path.dirname(dir) !== parent || !TOPIC_NAME.test(path.basename(dir))) {
    throw new TopicRefusal(`${arg} is not a topic folder — it must be docs/sparring/<yyyy-mm-dd>-<topic> (lowercase, hyphenated).`);
  }
  if (!existsSync(dir)) throw new TopicRefusal(`${path.relative(root, dir)} does not exist — write round-1-brief.md there first.`);
  // The folder itself, or docs/ or docs/sparring/ above it, must not be a link.
  if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== path.join(realpathSync(root), "docs", "sparring", path.basename(dir))) {
    throw new TopicRefusal(`${path.relative(root, dir)} is, or sits under, a symbolic link — a topic must be a plain folder in docs/sparring/.`);
  }
  return dir;
}

/**
 * The conversation for round N: brief 1, reply 1, …, brief N. Every earlier
 * round must be complete, and round N must not have been sent already — a
 * reply is never overwritten.
 */
export function readRounds(dir, round) {
  if (!Number.isInteger(round) || round < 1) throw new TopicRefusal("--round must be a positive whole number");
  if (existsSync(replyFile(dir, round))) throw new TopicRefusal(`round ${round} already has a reply — write round-${round + 1}-brief.md.`);
  const turns = [];
  const texts = [];
  for (let n = 1; n <= round; n += 1) {
    const brief = briefFile(dir, n);
    if (!existsSync(brief)) throw new TopicRefusal(`missing ${path.basename(brief)}`);
    const briefText = readPlain(brief);
    turns.push({ role: "user", text: briefText });
    texts.push({ name: path.basename(brief), text: briefText, brief: true });
    if (n === round) break;
    const reply = replyFile(dir, n);
    if (!existsSync(reply)) throw new TopicRefusal(`missing ${path.basename(reply)} — round ${n} was never sent`);
    const replyText = stripHeader(readPlain(reply));
    turns.push({ role: "assistant", text: replyText });
    texts.push({ name: path.basename(reply), text: replyText, brief: false });
  }
  return { turns, texts };
}

const HEADER = /^<!-- spar:[^\n]*-->\n\n?/;
const stripHeader = (text) => text.replace(HEADER, "");

export function writeReply(dir, round, text, { provider, model, effort, at }) {
  const header = `<!-- spar: ${provider} ${model} effort=${effort} ${at} — a critic of plans, not a source of facts; verify every factual claim -->\n\n`;
  writePlain(replyFile(dir, round), `${header}${text.trim()}\n`, constants.O_EXCL);
}

/** The committed per-topic record. No brief text, no headers, no keys. */
export function appendSend(dir, entry) {
  writePlain(path.join(dir, "sends.jsonl"), `${JSON.stringify(entry)}\n`, constants.O_APPEND);
}

/** Repo-relative `.env` files to read keys from: the root `.env` plus the
 *  project's extras, never absolute and never climbing out with `..`. */
function keyFiles(roots, extraFiles) {
  const rels = [".env", ...extraFiles.filter((f) => typeof f === "string" && !path.isAbsolute(f) && !f.split(/[\\/]/).includes(".."))];
  return roots.flatMap((root) => rels.map((rel) => path.join(root, rel)));
}

/** NAME's value in one `.env` file, or null. A file that is a link, or sits
 *  under one, is not read: it could point anywhere. */
function valueIn(file, name, root) {
  if (!existsSync(file)) return null;
  if (lstatSync(file).isSymbolicLink() || !realpathSync(file).startsWith(realpathSync(root) + path.sep)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && m[1] === name && m[2].trim()) return m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return null;
}

/** A key to SEND with: the environment first, else the first `.env` that
 *  has it. The value is returned, never printed. */
export function loadKey(name, env, roots, extraFiles = []) {
  return loadAllKeys(name, env, roots, extraFiles)[0] ?? null;
}

/** Every value NAME has anywhere — environment and every `.env` — for the
 *  GUARD: a decoy `.env` in a worktree must not hide the real value. */
export function loadAllKeys(name, env, roots, extraFiles = []) {
  const values = env[name] ? [env[name]] : [];
  for (const root of roots) {
    for (const file of keyFiles([root], extraFiles)) {
      const v = valueIn(file, name, root);
      if (v) values.push(v);
    }
  }
  return [...new Set(values)];
}
