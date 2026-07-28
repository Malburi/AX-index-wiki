#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { buildIndex, pairConfig } from "./build-index.mjs";

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function parseArgs(argv) {
  const result = { consumers: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--backend") result.backend = argv[++i];
    else if (["--consumer", "--client", "--frontend"].includes(argv[i])) result.consumers.push(argv[++i]);
    else if (argv[i] === "--quiet") result.quiet = true;
    else throw new Error(`알 수 없는 인자: ${argv[i]}`);
  }
  if (!result.backend || !result.consumers.length) throw new Error("--backend와 최소 1개의 --consumer가 필요합니다.");
  result.backend = resolve(result.backend);
  result.consumers = result.consumers.map((item) => resolve(item));
  return result;
}

function tierOf(root) {
  return readJson(join(root, "_workspace", "index", "_meta.json"), {})?.tier || "Auto";
}

function refresh(root) {
  return buildIndex({ root, mode: "incremental", tier: tierOf(root), config: join(root, "_workspace", "indexer-config.json"), quiet: true });
}

function driftOf(root) {
  const contractsPath = join(root, "_workspace", "index", "api_contracts.json");
  const contracts = readJson(contractsPath);
  if (!contracts) throw new Error(`클라이언트 API 계약을 생성하지 못했습니다: ${contractsPath}`);
  const localConsumers = (contracts.consumers || []).filter((item) => item.source !== "external");
  const localIds = new Set(localConsumers.map((item) => item.id));
  const unmatched = (contracts.unmatched_consumers || []).filter((id) => localIds.has(id));
  const matched = new Set((contracts.matches || []).map((item) => item.consumer_id).filter((id) => localIds.has(id)));
  return {
    endpoints: (contracts.endpoints || []).filter((item) => item.source === "external").length,
    consumers: localConsumers.length,
    matched: matched.size,
    unmatched_consumers: unmatched,
    status: unmatched.length ? "WARN" : "PASS",
  };
}

function clientReport(id, drift) {
  const rows = drift.unmatched_consumers.length ? drift.unmatched_consumers.map((item) => `- ${item}`).join("\n") : "- 없음";
  return `# API 계약 차이 검증 보고서\n\n## 종합 판정\n\n| 항목 | 결과 |\n|---|---|\n| 상태 | **${drift.status}** |\n| 클라이언트 | ${id} |\n| 백엔드 endpoint | ${drift.endpoints}개 |\n| Consumer 호출 | ${drift.consumers}개 |\n| 매칭 | ${drift.matched}개 |\n| 미매칭 | ${drift.unmatched_consumers.length}개 |\n\n## 미매칭 Consumer 호출\n\n${rows}\n\n## 판정 해석\n\n동적 URL과 런타임 base URL은 정적 분석만으로 확정할 수 없습니다. 미매칭 항목은 삭제 근거가 아니라 실제 환경 설정·네트워크 로그·통합 테스트로 확인할 목록입니다.\n\n## 기계 판정값\n\n\`status: ${drift.status}\`\n`;
}

// 백엔드 1개 : 클라이언트 N개(1:N)를 지원한다.
// 순서는 backend -> 각 client -> backend 최종이며, 마지막 backend refresh가 모든 클라이언트 계약을 역방향 반영한다.
export function refreshPair({ backend, consumer, consumers }) {
  const clients = (consumers?.length ? consumers : [consumer].filter(Boolean)).map((item) => resolve(item));
  if (!clients.length) throw new Error("최소 1개의 클라이언트 경로가 필요합니다.");
  for (const root of [backend, ...clients]) {
    if (!existsSync(join(root, "_workspace", "pair_config.md"))) throw new Error(`pair_config.md 누락: ${root}`);
  }
  const declared = (pairConfig(backend)?.partners || []).map((item) => resolve(item.root));
  const missing = clients.filter((item) => declared.length && !declared.includes(item));
  refresh(backend);
  const clientResults = [];
  for (const root of clients) {
    const partner = (pairConfig(backend)?.partners || []).find((item) => resolve(item.root) === root);
    clientResults.push({ id: partner?.id || basename(root), root, index: refresh(root) });
  }
  const backendFinal = refresh(backend);
  for (const entry of clientResults) {
    entry.drift = driftOf(entry.root);
    writeFileSync(join(entry.root, "_workspace", "api_drift_report.md"), clientReport(entry.id, entry.drift), "utf8");
    writeFileSync(join(entry.root, "_workspace", "pair_refresh_result.json"), `${JSON.stringify({ generated_at: new Date().toISOString(), backend, client: entry.id, ...entry.drift }, null, 2)}\n`, "utf8");
  }
  const unmatched = clientResults.flatMap((entry) => entry.drift.unmatched_consumers.map((id) => `${entry.id}::${id}`));
  const result = {
    generated_at: new Date().toISOString(),
    topology: clients.length > 1 ? "one-to-many" : "one-to-one",
    backend: backendFinal,
    clients: clientResults.map((entry) => ({ id: entry.id, root: entry.root, ...entry.drift })),
    // 1:1 하위 호환 필드 — 첫 클라이언트 기준
    consumer: clientResults[0].index,
    endpoints: clientResults[0].drift.endpoints,
    consumers: clientResults.reduce((total, entry) => total + entry.drift.consumers, 0),
    matched: clientResults.reduce((total, entry) => total + entry.drift.matched, 0),
    unmatched_consumers: unmatched,
    undeclared_clients: missing,
    status: unmatched.length || missing.length ? "WARN" : "PASS",
  };
  const summaryRows = result.clients
    .map((entry) => `| ${entry.id} | ${entry.status} | ${entry.endpoints} | ${entry.consumers} | ${entry.matched} | ${entry.unmatched_consumers.length} |`)
    .join("\n");
  const missingNote = missing.length ? `\n## 설정에 없는 클라이언트\n\n${missing.map((item) => `- ${item}`).join("\n")}\n\n\`pair_config.md\`의 \`## 파트너 목록\` 표에 추가해야 다음 실행에서 자동 인식됩니다.\n` : "";
  writeFileSync(join(backend, "_workspace", "pair_refresh_result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(join(backend, "_workspace", "api_drift_summary.md"), `# 클라이언트별 API 계약 차이 요약\n\n| 클라이언트 | 상태 | 백엔드 endpoint | Consumer 호출 | 매칭 | 미매칭 |\n|---|---|---:|---:|---:|---:|\n${summaryRows}\n\n## 종합 판정\n\n\`status: ${result.status}\` · 토폴로지 \`${result.topology}\` · 클라이언트 ${result.clients.length}개\n${missingNote}\n## 판정 해석\n\n미매칭은 삭제 근거가 아니라 확인 목록입니다. 클라이언트별 상세는 각 저장소의 \`_workspace/api_drift_report.md\`에 있습니다.\n`, "utf8");
  return result;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = refreshPair({ backend: args.backend, consumers: args.consumers });
    if (!args.quiet) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`페어 인덱스 갱신 실패: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
if (isMain) main();
