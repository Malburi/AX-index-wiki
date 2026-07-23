#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const INDEX_NAMES = [
  "symbols", "call_graph", "sql_usage", "transactions", "external_io",
  "env_branches", "schema", "api_contracts", "dead_code",
];
const MAX_BATCH = 200;
const MAX_RESULTS = 100;

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function parseArgs(argv) {
  const result = { root: process.cwd(), command: "summary", offset: 0, limit: 50, indexes: INDEX_NAMES };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") result.root = argv[++i];
    else if (arg === "--offset") result.offset = Number(argv[++i]);
    else if (arg === "--limit") result.limit = Number(argv[++i]);
    else if (arg === "--query") result.query = argv[++i];
    else if (arg === "--file") result.file = argv[++i];
    else if (arg === "--indexes") result.indexes = argv[++i].split(",").map((v) => v.trim()).filter((v) => INDEX_NAMES.includes(v));
    else positional.push(arg);
  }
  if (positional[0]) result.command = positional[0];
  result.root = resolve(result.root);
  if (!Number.isInteger(result.offset) || result.offset < 0) throw new Error("offset은 0 이상의 정수여야 합니다.");
  if (!Number.isInteger(result.limit) || result.limit < 1) throw new Error("limit은 1 이상의 정수여야 합니다.");
  return result;
}

function indexDir(root) {
  return join(root, "_workspace", "index");
}

function arraysOf(value) {
  return Object.entries(value || {}).filter(([, entries]) => Array.isArray(entries));
}

export function summary(root) {
  const path = join(indexDir(root), "_analysis_input.json");
  const value = readJson(path);
  if (!value) throw new Error(`분석 입력 팩이 없습니다: ${path}`);
  return value;
}

export function unresolvedBatch(root, offset = 0, limit = MAX_BATCH) {
  const path = join(indexDir(root), "_unresolved.jsonl");
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean) : [];
  const size = Math.min(limit, MAX_BATCH);
  const items = lines.slice(offset, offset + size).map((line) => JSON.parse(line));
  return { offset, limit: size, total: lines.length, next_offset: offset + items.length < lines.length ? offset + items.length : null, items };
}

export function searchIndex(root, { query = "", file = "", indexes = INDEX_NAMES, limit = 50 } = {}) {
  const normalizedQuery = query.toLowerCase();
  const normalizedFile = file.replace(/\\/g, "/").toLowerCase();
  if (!normalizedQuery && !normalizedFile) throw new Error("search에는 --query 또는 --file이 필요합니다.");
  const results = [];
  const capped = Math.min(limit, MAX_RESULTS);
  for (const name of indexes) {
    const value = readJson(join(indexDir(root), `${name}.json`));
    if (!value) continue;
    for (const [collection, entries] of arraysOf(value)) {
      for (const item of entries) {
        const serialized = JSON.stringify(item);
        const itemFile = String(item?.file || item?.source_file || "").replace(/\\/g, "/").toLowerCase();
        if (normalizedQuery && !serialized.toLowerCase().includes(normalizedQuery)) continue;
        if (normalizedFile && itemFile !== normalizedFile) continue;
        results.push({ index: name, collection, item });
        if (results.length >= capped) return { query, file, limit: capped, truncated: true, results };
      }
    }
  }
  return { query, file, limit: capped, truncated: false, results };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    let result;
    if (args.command === "summary") result = summary(args.root);
    else if (args.command === "unresolved") result = unresolvedBatch(args.root, args.offset, args.limit);
    else if (args.command === "search") result = searchIndex(args.root, args);
    else throw new Error(`지원하지 않는 명령: ${args.command}`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`인덱스 조회 실패: ${error.message}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
if (isMain) main();
