#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildIndex } from "./build-index.mjs";

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--backend") result.backend = argv[++i];
    else if (argv[i] === "--consumer") result.consumer = argv[++i];
    else if (argv[i] === "--quiet") result.quiet = true;
    else throw new Error(`알 수 없는 인자: ${argv[i]}`);
  }
  if (!result.backend || !result.consumer) throw new Error("--backend와 --consumer가 필요합니다.");
  result.backend = resolve(result.backend);
  result.consumer = resolve(result.consumer);
  return result;
}

function tierOf(root) {
  return readJson(join(root, "_workspace", "index", "_meta.json"), {})?.tier || "Auto";
}

function refresh(root) {
  return buildIndex({ root, mode: "incremental", tier: tierOf(root), config: join(root, "_workspace", "indexer-config.json"), quiet: true });
}

export function refreshPair({ backend, consumer }) {
  for (const root of [backend, consumer]) {
    if (!existsSync(join(root, "_workspace", "pair_config.md"))) throw new Error(`pair_config.md 누락: ${root}`);
  }
  const backendFirst = refresh(backend);
  const consumerResult = refresh(consumer);
  const backendFinal = refresh(backend);
  const contractsPath = join(consumer, "_workspace", "index", "api_contracts.json");
  const contracts = readJson(contractsPath);
  if (!contracts) throw new Error(`consumer API 계약을 생성하지 못했습니다: ${contractsPath}`);
  const localConsumers = (contracts.consumers || []).filter((item) => item.source !== "external");
  const localIds = new Set(localConsumers.map((item) => item.id));
  const unmatched = (contracts.unmatched_consumers || []).filter((id) => localIds.has(id));
  const matchedLocal = new Set((contracts.matches || []).map((item) => item.consumer_id).filter((id) => localIds.has(id)));
  const result = {
    generated_at: new Date().toISOString(),
    backend: backendFinal,
    consumer: consumerResult,
    endpoints: (contracts.endpoints || []).filter((item) => item.source === "external").length,
    consumers: localConsumers.length,
    matched: matchedLocal.size,
    unmatched_consumers: unmatched,
    status: unmatched.length ? "WARN" : "PASS",
  };
  const rows = unmatched.length ? unmatched.map((id) => `- ${id}`).join("\n") : "- 없음";
  const report = `# API 계약 차이 검증 보고서\n\n## 종합 판정\n\n| 항목 | 결과 |\n|---|---|\n| 상태 | **${result.status}** |\n| 백엔드 endpoint | ${result.endpoints}개 |\n| Consumer 호출 | ${result.consumers}개 |\n| 매칭 | ${result.matched}개 |\n| 미매칭 | ${unmatched.length}개 |\n\n## 미매칭 Consumer 호출\n\n${rows}\n\n## 판정 해석\n\n동적 URL과 런타임 base URL은 정적 분석만으로 확정할 수 없습니다. 미매칭 항목은 삭제 근거가 아니라 실제 환경 설정·네트워크 로그·통합 테스트로 확인할 목록입니다.\n\n## 기계 판정값\n\n\`status: ${result.status}\`\n`;
  writeFileSync(join(consumer, "_workspace", "api_drift_report.md"), report, "utf8");
  writeFileSync(join(consumer, "_workspace", "pair_refresh_result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = refreshPair(args);
    if (!args.quiet) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`페어 인덱스 갱신 실패: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
if (isMain) main();
