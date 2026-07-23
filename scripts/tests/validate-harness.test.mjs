import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex } from "../build-index.mjs";
import { validateHarness } from "../validate-harness.mjs";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function write(root, rel, content) {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

const SCOPE_MD = `# 초기화 분석 범위

## 사용자 확인 내용
- 프로젝트 위치: 임시 테스트 프로젝트
- 초기화 구성: 현재 폴더 단일
- 분석 범위: 전체 프로젝트를 대상으로 결정적 인덱서가 소스를 전수 수집한다

## 기계 실행 값
- init_layout: single-root
- analysis_scope: full
`;

const ANALYZER_MD = `# 프로젝트 심층 분석 보고서

## 분석 개요
간단한 TypeScript 헬퍼 모듈 하나로 구성된 테스트 프로젝트를 결정적 인덱스 기반으로 분석했다.

## 분석 범위와 커버리지
전체 소스 파일을 인덱서가 수집했고 커버리지는 전수이며 제외된 경로는 없다.

## 시스템 목적과 업무 범위
문자열 인사말을 반환하는 단일 기능을 제공하는 예제 시스템이다.

## 기술 스택과 실행 구조
TypeScript 단일 모듈로 구성되며 별도 프레임워크나 실행 서버는 없다.

## 아키텍처와 모듈 책임
단일 모듈 src/simple.ts:1 이 인사말 생성 책임을 가진다.

## 주요 업무 흐름
호출자가 hello 함수를 호출하면 src/simple.ts:1 에서 고정 문자열을 반환한다.

## 데이터와 저장소
영속 데이터 저장소를 사용하지 않으며 상태를 보관하지 않는다.

## API와 외부 연동
외부 API 호출이나 수신 엔드포인트가 존재하지 않는다.

## 트랜잭션과 데이터 일관성
트랜잭션 경계가 없으며 일관성 위험도 확인되지 않았다.

## 인증·인가와 보안
인증이나 인가 로직이 없고 보안 민감 데이터도 다루지 않는다.

## 운영·환경·배치
환경 분기나 배치 작업이 없어 운영 변수는 확인되지 않았다.

## 유지보수 위험과 개선 우선순위
규모가 작아 즉시 위험은 없으며 테스트 추가가 유일한 개선 항목이다.

## 패턴 근거

### helper — 헬퍼 함수 패턴

순수 함수를 export 하는 헬퍼 패턴이 src/simple.ts:1 에서 확인된다.

#### 실제 코드 예시

\`\`\`ts
export function hello() { return 'hello'; }
\`\`\`

## 미해결 사항과 확인 방법
미해결 관계는 없으며 인덱서 unresolved 목록도 비어 있다.

## 근거 원장
- src/simple.ts:1 — hello 함수 정의와 반환값
- _workspace/index/_meta.json — 결정적 인덱서가 기록한 커버리지와 Tier

## 분석 신뢰도
정적 분석만으로 전체 동작을 확인할 수 있어 신뢰도는 높음이다.
`;

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "ax-validator-"));
  write(root, "src/simple.ts", "export function hello() { return 'hello'; }\n");
  buildIndex({ root, mode: "init", tier: "Lite", config: null });
  write(root, "_workspace/00_init_scope.md", SCOPE_MD);
  write(root, "_workspace/01_analyzer_report.md", ANALYZER_MD);
  return root;
}

export async function test(register, assert) {
  register("--index-only는 writer 산출물 없이 FAIL이 아니다", () => {
    const root = makeFixture();
    try {
      const result = validateHarness({ root, pluginRoot: PLUGIN_ROOT, tier: "Lite", indexOnly: true });
      const failCodes = result.checks.filter((c) => c.level === "FAIL").map((c) => `${c.code}: ${c.message}`);
      assert.ok(result.status !== "FAIL", `index-only status: ${result.status} — ${failCodes.join(" / ")}`);
      assert.equal(result.mode, "index-only", "result.mode");
      assert.ok(!failCodes.some((c) => /FILE_MISSING|WRITER_|PATTERN_MISSING|CLAUDE_SECTION|DOCUMENT_LANGUAGE|PLACEHOLDER/.test(c)), `writer 계열 FAIL 부재: ${failCodes.join(" / ")}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  register("index-only 없이 실행하면 writer 산출물 누락이 FAIL로 잡힌다", () => {
    const root = makeFixture();
    try {
      const result = validateHarness({ root, pluginRoot: PLUGIN_ROOT, tier: "Lite" });
      assert.equal(result.status, "FAIL", "full mode status");
      assert.equal(result.mode, "full", "result.mode");
      const codes = result.checks.filter((c) => c.level === "FAIL").map((c) => c.code);
      assert.ok(codes.includes("FILE_MISSING"), `FILE_MISSING 포함: ${codes.join(",")}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  register("index-only에서도 analyzer 보고서 품질 검사는 유지된다", () => {
    const root = makeFixture();
    try {
      write(root, "_workspace/01_analyzer_report.md", "# 프로젝트 심층 분석 보고서\n\n## 분석 개요\n짧음.\n");
      const result = validateHarness({ root, pluginRoot: PLUGIN_ROOT, tier: "Lite", indexOnly: true });
      assert.equal(result.status, "FAIL", "부실한 analyzer 보고서는 index-only에서도 FAIL");
      const codes = result.checks.filter((c) => c.level === "FAIL").map((c) => c.code);
      assert.ok(codes.some((c) => c.startsWith("ANALYZER_")), `ANALYZER_* 포함: ${codes.join(",")}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
