#!/usr/bin/env node
import {
  existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const INDEX_SCHEMAS = [
  "symbols", "call_graph", "sql_usage", "transactions", "external_io",
  "env_branches", "schema", "api_contracts", "dead_code",
];

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function parseArgs(argv) {
  const args = { root: process.cwd(), pluginRoot: resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") args.root = argv[++i];
    else if (argv[i] === "--plugin-root") args.pluginRoot = argv[++i];
    else if (argv[i] === "--tier") args.tier = argv[++i];
    else if (argv[i] === "--index-only") args.indexOnly = true;
    else if (argv[i] === "--quiet") args.quiet = true;
    else throw new Error(`알 수 없는 인자: ${argv[i]}`);
  }
  args.root = resolve(args.root);
  args.pluginRoot = resolve(args.pluginRoot);
  return args;
}

function matchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === type;
}

function validateSchema(value, schema, location, loadRef, errors) {
  if (schema.$ref) return validateSchema(value, loadRef(schema.$ref), location, loadRef, errors);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((type) => matchesType(value, type))) {
    errors.push(`${location}: 타입 불일치(expected ${types.join("|")})`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${location}: 허용되지 않은 값 ${JSON.stringify(value)}`);
  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) {
    errors.push(`${location}: 최솟값 ${schema.minimum} 미만`);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${location}.${key}: 필수 필드 누락`);
    for (const [key, child] of Object.entries(schema.properties || {})) if (key in value) {
      validateSchema(value[key], child, `${location}.${key}`, loadRef, errors);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateSchema(item, schema.items, `${location}[${index}]`, loadRef, errors));
  }
}

function collectEvidenceFiles(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceFiles(item, output);
  } else if (value && typeof value === "object") {
    const path = value.file || value.source_file;
    if (typeof path === "string" && value.source !== "external") output.push(path);
    for (const child of Object.values(value)) collectEvidenceFiles(child, output);
  }
  return output;
}

function relativeSourceExists(root, path) {
  if (!path || isAbsolute(path) || path.includes("..")) return false;
  return existsSync(join(root, path.split(/[\\/]/).join(sep)));
}

function markdownFiles(root) {
  const paths = [join(root, "CLAUDE.md"), join(root, ".claude", "ito-guide.md"), join(root, ".claude", "agents", "domain-expert.md")];
  const patterns = join(root, ".claude", "patterns");
  if (existsSync(patterns)) for (const name of readdirSync(patterns)) if (name.endsWith(".md")) paths.push(join(patterns, name));
  return paths.filter(existsSync);
}

function add(checks, level, code, message) {
  checks.push({ level, code, message });
}

function sourceReferences(markdown) {
  return new Set([...markdown.matchAll(/(?:^|[\s`(])([\w@+~./\\-]+\.[A-Za-z0-9]+):(\d+)/gm)].map((match) => `${match[1]}:${match[2]}`));
}

function schemaFailureCode(document) {
  return document?._meta?.generator === "deterministic-indexer" ? "PLUGIN_INDEX_CONTRACT" : "INDEX_SCHEMA";
}

function headingSection(markdown, level, title) {
  const heading = new RegExp(`^#{${level}}\\s+${title}\\s*$`, "im").exec(markdown);
  if (!heading) return "";
  const start = heading.index + heading[0].length;
  const tail = markdown.slice(start);
  const next = new RegExp(`^#{1,${level}}\\s+`, "m").exec(tail);
  return next ? tail.slice(0, next.index) : tail;
}

function headingSections(markdown, level) {
  const matches = [...markdown.matchAll(new RegExp(`^#{${level}}\\s+(.+?)\\s*$`, "gm"))];
  return matches.map((match, index) => ({
    title: match[1].trim(),
    body: markdown.slice(match.index + match[0].length, matches[index + 1]?.index ?? markdown.length),
  }));
}

function headingSectionContaining(markdown, level, names) {
  const wanted = names.map((name) => name.toLowerCase());
  return headingSections(markdown, level).find((section) => wanted.some((name) => section.title.toLowerCase().includes(name))) || null;
}

// 결정적 후보가 오탐/실제 근거 없음으로 analyzer가 사유를 남기고 보류한 항목은
// Full tier의 "후보별 Pattern Evidence" 요건을 채운 것으로 인정한다. 사유 미기재 스킵은 인정하지 않는다.
function documentedHeldPatternSlugs(analyzer, patternCandidates) {
  const held = new Set();
  const section = headingSectionContaining(analyzer, 2, ["패턴 후보 검토"]);
  if (!section) return held;
  const slugSet = new Set(patternCandidates.map((item) => item.slug));
  const rows = section.body.split(/\r?\n/).filter((line) => line.trim().startsWith("|"));
  for (const row of rows) {
    const cells = row.split("|").map((cell) => cell.trim()).filter((cell, index, array) => !(index === 0 && cell === "") && !(index === array.length - 1 && cell === ""));
    if (cells.length < 2 || /^-{2,}$/.test(cells[1] || "")) continue;
    const slug = cells[0];
    if (!slugSet.has(slug)) continue;
    const rest = cells.slice(1).join(" | ");
    const reasonLength = rest.replace(/[^가-힣a-zA-Z0-9]/g, "").length;
    if (/보류|오탐/.test(rest) && reasonLength > 15) held.add(slug);
  }
  return held;
}

function koreanCharacterCount(markdown) {
  return (String(markdown || "").match(/[가-힣]/g) || []).length;
}

function meaningfulMarkdownLines(markdown) {
  return String(markdown || "").split(/\r?\n/).filter((line) => {
    const value = line.trim();
    return value && !/^#{1,6}\s/.test(value) && !/^```/.test(value) && !/^\|?\s*:?-{3,}/.test(value);
  }).length;
}

function usableCodeBlocks(markdown) {
  return [...markdown.matchAll(/^(`{3,})([^\r\n`]*)\r?\n([\s\S]*?)^\1\s*$/gm)]
    .map((match) => match[3].trim())
    .filter((body) => body && body !== "..." && !/^\[[^\]\r\n]+\]$/.test(body));
}

function hasActualCodeExample(markdown) {
  for (const level of [2, 3, 4]) {
    const section = headingSection(markdown, level, "실제 코드 예시");
    if (section && usableCodeBlocks(section).length) return true;
  }
  return false;
}

export function validateHarness({ root, pluginRoot, tier: requestedTier, indexOnly = false }) {
  const checks = [];
  const indexDir = join(root, "_workspace", "index");
  const meta = readJson(join(indexDir, "_meta.json"));
  if (!meta) add(checks, "FAIL", "META_MISSING", "_workspace/index/_meta.json이 없거나 JSON 파싱에 실패했습니다.");
  const tier = requestedTier || meta?.tier || "Standard";
  const analysisInput = readJson(join(indexDir, "_analysis_input.json"), {});
  const patternCandidates = Array.isArray(analysisInput?.pattern_candidates?.categories)
    ? analysisInput.pattern_candidates.categories
    : [];
  const requiredPatternCount = patternCandidates.length > 1
    ? (tier === "Lite" ? Math.min(2, patternCandidates.length) : patternCandidates.length)
    : patternCandidates.length;
  let analyzerPatternCategoryCount = 0;
  let heldPatternSlugs = new Set();
  // index-only: writer 산출물(CLAUDE.md·ito-guide·domain-expert·02_writer_files) 없이
  // 인덱스+analyzer 보고서만 검증한다. 인덱스·위키 전용 배포에서 사용.
  const requiredFiles = [
    ...(indexOnly ? [] : ["CLAUDE.md", ".claude/ito-guide.md", ".claude/agents/domain-expert.md", "_workspace/02_writer_files.md"]),
    "_workspace/00_init_scope.md", "_workspace/01_analyzer_report.md",
    "_workspace/index/_meta.json", "_workspace/index/_analysis_input.json",
    "_workspace/index/symbols.json", "_workspace/index/call_graph.json",
  ];
  for (const path of requiredFiles) {
    if (!existsSync(join(root, path))) add(checks, "FAIL", "FILE_MISSING", `${path} 누락`);
  }

  const scopePath = join(root, "_workspace", "00_init_scope.md");
  const scope = existsSync(scopePath) ? readFileSync(scopePath, "utf8") : "";
  if (scope && (!/^#\s+초기화 분석 범위\s*$/m.test(scope) || koreanCharacterCount(scope) < 40)) {
    add(checks, "FAIL", "SCOPE_LANGUAGE", "00_init_scope.md가 한국어 초기화 범위 보고서 형식이 아닙니다.");
  }

  const schemaDir = join(pluginRoot, "docs", "index-schema");
  const schemaCache = new Map();
  const loadSchema = (name) => {
    const normalized = name.replace(/^\.\//, "");
    if (!schemaCache.has(normalized)) schemaCache.set(normalized, readJson(join(schemaDir, normalized), {}));
    return schemaCache.get(normalized);
  };
  if (meta) {
    const errors = [];
    validateSchema(meta, loadSchema("_meta.schema.json"), "_meta", loadSchema, errors);
    for (const error of errors) add(checks, "FAIL", schemaFailureCode(meta), error);
  }
  for (const name of INDEX_SCHEMAS) {
    const path = join(indexDir, `${name}.json`);
    if (!existsSync(path)) continue;
    const value = readJson(path);
    if (!value) { add(checks, "FAIL", "INDEX_PARSE", `${name}.json 파싱 실패`); continue; }
    const errors = [];
    validateSchema(value, loadSchema(`${name}.schema.json`), name, loadSchema, errors);
    for (const error of errors) add(checks, "FAIL", schemaFailureCode(value), error);
    for (const file of new Set(collectEvidenceFiles(value))) {
      if (!relativeSourceExists(root, file)) add(checks, "FAIL", "EVIDENCE_PATH", `${name}.json 근거 파일 없음: ${file}`);
    }
  }

  const graph = readJson(join(indexDir, "call_graph.json"));
  if (graph) {
    const ids = new Set((graph.nodes || []).map((node) => node.id));
    for (const edge of graph.edges || []) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) add(checks, "FAIL", "GRAPH_REFERENCE", `존재하지 않는 노드 참조: ${edge.from} -> ${edge.to}`);
      if (edge.origin === "ai-enrichment" && (!edge.evidence || !edge.file || !Number.isInteger(edge.line))) {
        add(checks, "FAIL", "AI_EVIDENCE", `AI 보강 edge에 file:line/evidence 누락: ${edge.from} -> ${edge.to}`);
      }
    }
  }

  if (meta) {
    if (meta.generator !== "deterministic-indexer") add(checks, "WARN", "GENERATOR", `_meta.generator=${meta.generator}`);
    for (const name of meta.indexes || []) if (!existsSync(join(indexDir, `${name}.json`))) add(checks, "FAIL", "DECLARED_INDEX", `_meta에 선언됐지만 파일이 없음: ${name}.json`);
    const unresolvedPath = join(indexDir, "_unresolved.jsonl");
    const unresolved = existsSync(unresolvedPath) ? readFileSync(unresolvedPath, "utf8").split(/\r?\n/).filter(Boolean).length : 0;
    if (unresolved !== meta.unresolved_count) add(checks, "FAIL", "UNRESOLVED_COUNT", `_meta=${meta.unresolved_count}, 실제=${unresolved}`);
  }

  const analyzerPath = join(root, "_workspace", "01_analyzer_report.md");
  const analyzer = existsSync(analyzerPath) ? readFileSync(analyzerPath, "utf8") : "";
  if (analyzer) {
    const requiredSections = [
      "분석 개요", "분석 범위와 커버리지", "시스템 목적과 업무 범위", "기술 스택과 실행 구조",
      "아키텍처와 모듈 책임", "주요 업무 흐름", "데이터와 저장소", "API와 외부 연동",
      "트랜잭션과 데이터 일관성", "인증·인가와 보안", "운영·환경·배치", "유지보수 위험과 개선 우선순위",
      "패턴 근거", "미해결 사항과 확인 방법", "근거 원장", "분석 신뢰도",
    ];
    const h2 = headingSections(analyzer, 2);
    for (const title of requiredSections) {
      const section = h2.find((item) => item.title.includes(title));
      if (!section) add(checks, "FAIL", "ANALYZER_SECTION", `analyzer 보고서에 '${title}' 섹션이 없습니다.`);
      else if (title !== "패턴 근거" && meaningfulMarkdownLines(section.body) < 1) add(checks, "FAIL", "ANALYZER_SECTION_DETAIL", `'${title}' 섹션에 설명이 없습니다.`);
    }
    const koreanMinimum = tier === "Full" ? 500 : tier === "Standard" ? 350 : 250;
    const lineMinimum = tier === "Full" ? 35 : tier === "Standard" ? 25 : 18;
    if (!/^#\s+프로젝트 심층 분석 보고서\s*$/m.test(analyzer) || koreanCharacterCount(analyzer) < koreanMinimum) {
      add(checks, "FAIL", "ANALYZER_LANGUAGE", `analyzer 보고서의 한국어 설명이 부족합니다: ${koreanCharacterCount(analyzer)}/${koreanMinimum}자`);
    }
    if (meaningfulMarkdownLines(analyzer) < lineMinimum) add(checks, "FAIL", "ANALYZER_DETAIL", `analyzer 보고서가 지나치게 간략합니다: ${meaningfulMarkdownLines(analyzer)}/${lineMinimum}개 내용 행`);
    for (const title of ["아키텍처와 모듈 책임", "주요 업무 흐름"]) {
      const section = h2.find((item) => item.title.includes(title));
      if (section && !sourceReferences(section.body).size) add(checks, "FAIL", "ANALYZER_SECTION_DETAIL", `'${title}' 섹션에 file:line 근거가 없습니다.`);
    }
    const refs = sourceReferences(analyzer);
    const minimum = Math.min(20, Math.max(5, Math.ceil((meta?.source_file_count || 1) * 0.2)));
    if (tier === "Full" && refs.size < minimum) add(checks, "FAIL", "EVIDENCE_DENSITY", `Full 분석 근거가 부족합니다: ${refs.size}/${minimum} file:line`);
    if (!/커버리지|coverage/i.test(analyzer)) add(checks, "WARN", "COVERAGE_SECTION", "analyzer 리포트에 커버리지 섹션이 없습니다.");
    if ((meta?.unresolved_count || 0) > 0 && !/미해결|unresolved/i.test(analyzer)) add(checks, "FAIL", "UNRESOLVED_REPORT", "미해결 관계가 있지만 analyzer 리포트에 처리 결과가 없습니다.");
    const patternEvidence = headingSectionContaining(analyzer, 2, ["패턴 근거", "pattern evidence"])?.body || "";
    if (!patternEvidence) add(checks, "FAIL", "ANALYZER_PATTERN_EVIDENCE", "analyzer 리포트에 Pattern Evidence 섹션이 없습니다.");
    else {
      const categories = headingSections(patternEvidence, 3);
      analyzerPatternCategoryCount = categories.length;
      if (!categories.length) add(checks, "FAIL", "ANALYZER_PATTERN_EVIDENCE", "Pattern Evidence에 category 블록이 없습니다.");
      for (const category of categories) {
        if (!sourceReferences(category.body).size) add(checks, "FAIL", "ANALYZER_PATTERN_EVIDENCE", `Pattern Evidence category '${category.title}'에 실제 file:line 근거가 없습니다.`);
        if (!hasActualCodeExample(category.body)) add(checks, "FAIL", "ANALYZER_PATTERN_EXAMPLE", `Pattern Evidence category '${category.title}'에 '실제 코드 예시' 코드 블록이 없습니다.`);
      }
      heldPatternSlugs = documentedHeldPatternSlugs(analyzer, patternCandidates);
      const evidenceSlugs = new Set(patternCandidates.map((item) => item.slug).filter((slug) => categories.some((category) => category.title.toLowerCase().includes(slug.toLowerCase()))));
      for (const slug of evidenceSlugs) heldPatternSlugs.delete(slug);
      const satisfied = categories.length + heldPatternSlugs.size;
      if (requiredPatternCount > 1 && satisfied < requiredPatternCount) {
        const slugs = patternCandidates.map((item) => item.slug).join(", ");
        const heldNote = heldPatternSlugs.size ? ` (문서화된 보류 ${heldPatternSlugs.size}건 인정: ${[...heldPatternSlugs].join(", ")})` : "";
        add(checks, "FAIL", "PATTERN_CATEGORY_COVERAGE", `결정적 인덱스가 ${patternCandidates.length}개 패턴 후보(${slugs})를 탐지했지만 analyzer Pattern Evidence+문서화된 보류는 ${satisfied}개입니다.${heldNote} ${tier} Tier 최소 ${requiredPatternCount}개가 필요합니다.`);
      }
    }
  }

  if (!indexOnly) {
    const writerPath = join(root, "_workspace", "02_writer_files.md");
    const writerReport = existsSync(writerPath) ? readFileSync(writerPath, "utf8") : "";
    for (const match of writerReport.matchAll(/PATTERN_EVIDENCE_MISSING:\s*([a-zA-Z0-9_.-]+)/gi)) {
      const slug = match[1];
      if (!heldPatternSlugs.has(slug)) {
        add(checks, "FAIL", "ANALYZER_PATTERN_EVIDENCE", `writer가 문서화되지 않은 Pattern Evidence 누락을 보고했습니다: ${slug} (analyzer의 '패턴 후보 검토' 표에 근거 있는 보류 사유가 없음)`);
      }
    }
    if (writerReport) {
      const requiredWriterSections = ["실행 개요", "생성·수정 파일", "프로젝트 지식 반영 내용", "변경하지 않은 파일과 이유", "충돌·보류·누락", "위키 활용 안내", "생성하지 않은 공통 항목"];
      if (!/^#\s+프로젝트 문서화 결과 보고서\s*$/m.test(writerReport) || koreanCharacterCount(writerReport) < 120) {
        add(checks, "FAIL", "WRITER_REPORT_LANGUAGE", "02_writer_files.md가 충분한 한국어 문서화 결과 보고서가 아닙니다.");
      }
      for (const title of requiredWriterSections) if (!headingSectionContaining(writerReport, 2, [title])) {
        add(checks, "FAIL", "WRITER_REPORT_DETAIL", `02_writer_files.md에 '${title}' 섹션이 없습니다.`);
      }
    }

    const generated = markdownFiles(root);
    // (?<![A-Za-z]) — camelCase 변수명(예: userPassword)의 접미어로 매칭되는 오탐을 막는다.
    // snake_case/시작 위치(예: db_password, password:)는 계속 정상 탐지된다.
    const secret = /(?<![A-Za-z])(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?(?!\[|<|\*|unknown|null|none|미확인)([^\s"']{8,})/ig;
    for (const path of generated) {
      const content = readFileSync(path, "utf8");
      if (/\[TODO:|작성\s*예정|TBD/i.test(content)) add(checks, "FAIL", "PLACEHOLDER", `${relative(root, path)}에 미완성 placeholder가 있습니다.`);
      if (secret.test(content)) add(checks, "FAIL", "SECRET", `${relative(root, path)}에 비밀값으로 보이는 문자열이 있습니다.`);
      if (koreanCharacterCount(content) < 25) add(checks, "FAIL", "DOCUMENT_LANGUAGE", `${relative(root, path)}의 한국어 설명이 부족합니다.`);
      secret.lastIndex = 0;
    }
    const claude = existsSync(join(root, "CLAUDE.md")) ? readFileSync(join(root, "CLAUDE.md"), "utf8") : "";
    for (const section of ["자동 워크플로우", "변경 이력"]) if (claude && !claude.includes(section)) add(checks, "FAIL", "CLAUDE_SECTION", `CLAUDE.md에 '${section}' 섹션이 없습니다.`);

    const patternDir = join(root, ".claude", "patterns");
    const patterns = existsSync(patternDir) ? readdirSync(patternDir).filter((name) => name.endsWith(".md")) : [];
    if (!patterns.length) add(checks, "FAIL", "PATTERN_MISSING", ".claude/patterns/*.md가 없습니다.");
    const requiredPatternFileCount = Math.max(0, requiredPatternCount - heldPatternSlugs.size);
    if (requiredPatternCount > 1 && patterns.length < requiredPatternFileCount) {
      const heldNote = heldPatternSlugs.size ? ` (문서화된 보류 ${heldPatternSlugs.size}건 제외: ${[...heldPatternSlugs].join(", ")})` : "";
      add(checks, "FAIL", "PATTERN_FILE_COVERAGE", `패턴 후보 ${patternCandidates.length}개와 analyzer category ${analyzerPatternCategoryCount}개에 비해 최종 패턴 파일이 ${patterns.length}개뿐입니다.${heldNote} ${tier} Tier 최소 ${requiredPatternFileCount}개가 필요합니다.`);
    }
    for (const name of patterns) {
      const content = readFileSync(join(patternDir, name), "utf8");
      if (!sourceReferences(content).size) add(checks, "FAIL", "PATTERN_EVIDENCE", `실제 file:line 근거가 없는 패턴: ${name}`);
      if (!hasActualCodeExample(content)) add(checks, "FAIL", "PATTERN_EXAMPLE", `'실제 코드 예시' 코드 블록이 없는 패턴: ${name}`);
      if (/pattern-extractor 에이전트가 채울 예정|추출 대상\s*$/m.test(content)) add(checks, "FAIL", "PATTERN_SKELETON", `스켈레톤 상태: ${name}`);
    }
  }

  const failures = checks.filter((item) => item.level === "FAIL").length;
  const warnings = checks.filter((item) => item.level === "WARN").length;
  const pluginContractFailures = checks.filter((item) => item.level === "FAIL" && item.code === "PLUGIN_INDEX_CONTRACT").length;
  const score = Math.max(0, 100 - failures * 12 - warnings * 3);
  const status = failures ? "FAIL" : warnings ? "WARN" : "PASS";
  const result = {
    generated_at: new Date().toISOString(), root, tier, status, score,
    mode: indexOnly ? "index-only" : "full",
    failures, warnings, plugin_contract_failures: pluginContractFailures, checks,
    coverage: {
      source_files: meta?.source_file_count || 0,
      indexes: meta?.indexes || [],
      unresolved: meta?.unresolved_count || 0,
    },
  };
  const workspace = join(root, "_workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "03_validator_result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  const rows = checks.length
    ? checks.map((item) => `| ${item.level} | ${item.code} | ${item.message.replace(/\|/g, "\\|")} |`).join("\n")
    : "| PASS | ALL | 결정적 검증 항목을 모두 통과했습니다. |";
  const followup = pluginContractFailures
    ? "- `PLUGIN_INDEX_CONTRACT`는 프로젝트 소스나 analyzer/writer 산출물 문제가 아니라 설치된 플러그인의 인덱서-스키마 계약 결함입니다.\n- 설치 캐시를 직접 수정하거나 AI 보완 호출을 사용하지 마세요. AX-Harness 정본을 업데이트한 뒤 기존 analyzer/writer 문서를 보존하고 MJS 인덱싱과 validator만 다시 실행해야 합니다.\n- 플러그인 업데이트 전에는 초기화 완료를 선언하거나 pair-init을 진행하면 안 됩니다."
    : failures
      ? "- FAIL 코드의 담당 단계만 보완한 뒤 validator를 다시 실행해야 합니다.\n- 실패 항목을 남긴 상태로 초기화 완료를 선언하면 안 됩니다."
      : warnings
        ? "- 초기화 결과는 사용할 수 있지만 WARN 항목을 런타임 또는 담당자 확인으로 보완하는 것이 좋습니다."
        : "- 결정적 검증 항목을 모두 통과했습니다. 이 보고서와 analyzer 근거를 위키에서 그대로 확인할 수 있습니다.";
  const verifiedItems = [
    "- 전체 index JSON 스키마의 필수값·타입·허용값",
    "- 호출 그래프 참조 무결성과 AI 보강 관계의 file:line 근거",
    "- index가 가리키는 실제 소스 파일의 존재 여부",
    "- analyzer 보고서의 한국어 상세 섹션·근거 밀도·미해결 관계",
    ...(indexOnly
      ? ["- Pattern Evidence category별 file:line 근거와 실제 코드 예시", "- (index-only 모드 — writer 산출 문서 검사는 생략)"]
      : [
        "- Pattern Evidence와 최종 패턴 문서의 실제 코드 예시",
        "- CLAUDE.md·domain-expert·ito-guide·patterns의 한국어 설명과 완성도",
        "- 생성 문서의 placeholder·비밀값 의심 패턴",
      ]),
  ].join("\n");
  const report = `# 하네스 초기화 검증 보고서\n\n## 종합 판정\n\n| 항목 | 결과 |\n|---|---|\n| 최종 상태 | **${status}** |\n| 품질 점수 | **${score}/100** |\n| 검증 모드 | ${indexOnly ? "index-only" : "full"} |\n| 분석 Tier | ${tier} |\n| 분석한 소스 | ${result.coverage.source_files}개 |\n| 미해결 관계 | ${result.coverage.unresolved}개 |\n\n## 발견 사항\n\n| 판정 | 코드 | 상세 내용 |\n|---|---|---|\n${rows}\n\n## 검증한 내용\n\n${verifiedItems}\n\n## 후속 조치\n\n${followup}\n`;
  writeFileSync(join(workspace, "03_validator_report.md"), report, "utf8");
  return result;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = validateHarness(args);
    if (!args.quiet) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.failures) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`하네스 검증 실패: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
if (isMain) main();
