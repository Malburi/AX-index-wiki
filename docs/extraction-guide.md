# AX-Harness → 인덱스·위키 기능 이식 가이드

이 문서는 AX-Harness(v0.6.1)에서 **인덱스 JSON 생성 체계**와 **위키 생성 체계**를 추출해 이 자립형 플러그인(AX-Index-Wiki)을 만든 근거와, 이 패키지를 **다른 기존 플러그인에 병합**할 때의 절차를 정리한다.

## 1. 추출 파일 분류

### 1-1. verbatim 복사 (수정 0)

| 파일 | 근거 |
|------|------|
| `scripts/build-index.mjs` (1,257줄) | Node 내장(fs/path/crypto/child_process)만 import. 외부 경로 참조 0건 |
| `scripts/query-index.mjs` (98줄) | `_workspace/index/`만 읽는 자립 스크립트 |
| `scripts/ai-budget.mjs` (81줄) | `_workspace/ai-budget.json`만 사용, 역할명은 인자 |
| `scripts/refresh-pair-index.mjs` (75줄) | `./build-index.mjs` 상대 import 하나뿐 |
| `scripts/build-wiki.mjs` (1,353줄) | 외부 import는 `./refresh-pair-index.mjs` 하나. writer 산출물은 전부 optional fallback으로 읽음 |
| `docs/index-schema/*.schema.json` (11개) | validator·wiki-narrative 계약의 원본 |
| `docs/index-spec.md`, `stack-matrix.md`, `paradigm-registry.md`, `host-compatibility.md` | analyzer·스킬이 참조하는 문서 |
| `scripts/tests/build-index.test.mjs` | fixture를 mkdtemp로 인라인 생성 — 별도 fixture 디렉터리 불필요 |
| `skills/build-wiki/SKILL.md` | harness-init·ai-budget·범위 밖 에이전트 참조 없음 (grep 검증) |

**import 체인 주의**: `build-wiki.mjs → refresh-pair-index.mjs → build-index.mjs`. 셋은 반드시 같은 `scripts/` 폴더에 함께 있어야 한다.

### 1-2. 복사 + 수정

| 파일 | 수정 내용 |
|------|----------|
| `scripts/validate-harness.mjs` | **`--index-only` 플래그 신설** (유일한 실질 코드 수정 — 아래 2장) |
| `agents/analyzer.md` | writer 인용 문구 4곳만 "후속 위키 생성"으로 교체. **16섹션 한국어 보고서 계약·Pattern Evidence·`_ai_patch.json` 계약은 그대로 유지** |
| `agents/wiki-builder.md` | 입력 목록의 CLAUDE.md·ito-guide·domain-expert를 "존재하는 경우에만 참조"로 완화 |
| `skills/pair-init/SKILL.md` | 범위 밖 참조(cross-repo-scaffold·analyze-impact·impact-analyzer·qa·api-bridge) 제거, 사전 검증 조건을 `_meta.json + 03_validator_result.json(PASS/WARN)`으로 대체, CLAUDE.md 파트너 섹션은 "기존 CLAUDE.md가 있을 때만" 갱신 |

### 1-3. 신규 작성

| 파일 | 내용 |
|------|------|
| `skills/index-init/SKILL.md` | `harness-init`(565줄)에서 인덱스 파이프라인만 발라낸 축소판 — 아래 3장 |
| `scripts/tests/run.js` | build-index + validate-harness 테스트만 import하는 축소 러너 |
| `scripts/tests/validate-harness.test.mjs` | index-only 플래그 회귀 테스트 3건 |
| `.claude-plugin/plugin.json`, `marketplace.json`, `package.json`, `README.md` | 플러그인 매니페스트 |

### 1-4. 의도적으로 제외한 것

writer·qa·harness-evaluator·spec-clarifier·pattern-extractor·api-bridge 에이전트, 작업용 에이전트 전체(impact-analyzer, change-safety 등), `task-state.mjs`, `validate-consistency.mjs`, `sync-codex-plugin.mjs`(Codex 미러), hooks, harness-clean.

## 2. validate-harness.mjs `--index-only` 설계

원본 validator는 writer 산출물(CLAUDE.md 섹션·`.claude/patterns/*.md`·domain-expert·`02_writer_files.md`)을 FAIL로 필수 검사한다. writer가 없는 이 패키지에서는 초기화가 항상 FAIL이 되므로 플래그로 조건화했다. **fork(별도 스크립트 분리)는 하지 않았다** — `validateSchema`/`collectEvidenceFiles`/`headingSection*` 헬퍼와 인덱스·그래프·analyzer 검사를 공유하므로 fork하면 이중 유지보수가 된다.

가드한 블록 (indexOnly=true면 스킵):

1. `requiredFiles`에서 `CLAUDE.md`·`.claude/ito-guide.md`·`domain-expert.md`·`02_writer_files.md` 4건 제외
2. writer 보고서 검사 (`WRITER_REPORT_*`, writer발 `PATTERN_EVIDENCE_MISSING` 교차검사)
3. 생성 문서 검사 (`PLACEHOLDER`/`SECRET`/`DOCUMENT_LANGUAGE`/`CLAUDE_SECTION`)
4. 패턴 파일 검사 (`PATTERN_MISSING`/`PATTERN_FILE_COVERAGE`/`PATTERN_EVIDENCE`/`PATTERN_EXAMPLE`/`PATTERN_SKELETON`)

**유지한 것 (index-only에서도 검사)**: analyzer 보고서 전체 — 16개 필수 섹션, 한국어 분량, file:line 근거 밀도, `ANALYZER_PATTERN_EVIDENCE`/`ANALYZER_PATTERN_EXAMPLE`/`PATTERN_CATEGORY_COVERAGE`. 이 부분은 위키 fallback 원문의 품질 게이트라서 끄면 위키 conventions·업무 흐름 페이지의 근거가 사라진다.

result JSON에 `mode: "index-only" | "full"` 필드가 추가됐고, `build-wiki.mjs`는 `status === "FAIL"`만 검사하므로 그대로 호환된다.

## 3. index-init 스킬 — harness-init에서 가져온 것/버린 것

**가져온 것**: Phase -1 Init Scope Gate 전체(4개 구성 선택 + `00_init_scope.md` 템플릿 — validator `SCOPE_LANGUAGE` 검사 대상이라 형식 불변), 백업·구성 적용·paired-roots 준비·Tier 자동결정, Phase 2-0 결정적 인덱싱 + `ai-budget init`(단 `--initial 4` → `--initial 1`, AI 역할이 analyzer뿐), Phase 2-1 analyzer 호출 + `_ai_patch.json` 병합, Phase 2-3 validator(+`--index-only`), Phase 2-4.5 pair barrier→pair-init→refresh, WIKI-ASK, 완료 보고·재실행·실패 정책.

**버린 것**: Phase 2-2 writer, Phase 2-5 qa+harness-evaluator, pattern-extractor 재추출, 작업 그래프의 T-W/T-Q/T-E 계열, FAIL 라우팅의 writer 계열 행.

Lane 구조는 `I → A → V`로 축소된다:

```
단일:  T-I 인덱싱 → T-A analyzer → T-V validator(--index-only) → WIKI-ASK
pair:  B-I→B-A→B-V ─┐
                     ├→ P-BARRIER → P-PAIR → P-REFRESH → WIKI-ASK
       C-I→C-A→C-V ─┘
```

## 4. 레이아웃 불변 조건

- `validate-harness.mjs`는 pluginRoot 기본값을 `자기 위치/..`로 잡고 `pluginRoot/docs/index-schema/*.schema.json`을 로드한다. → **`scripts/`와 `docs/index-schema/`의 상대 위치를 바꾸면 안 된다.** 바꿔야 하면 항상 `--plugin-root`를 명시한다.
- 스킬들의 `../../docs/host-compatibility.md` 상대 참조도 `skills/<name>/SKILL.md` ↔ `docs/` 레이아웃을 전제한다.
- 스키마 로드는 `readJson(..., {})` fallback이라 경로가 깨져도 **조용히 빈 스키마로 통과**한다. 이식 후 스모크에서 반드시 의도적으로 잘못된 스키마를 주입해 FAIL(`PLUGIN_INDEX_CONTRACT` 또는 `INDEX_SCHEMA`)이 나는지 확인한다 (아래 6장 4단계).

## 5. 다른 기존 플러그인에 병합할 때 체크리스트

1. **파일 이동**: `scripts/`(6개 + tests), `docs/index-schema/`(11개), `docs/` 문서 4종, `agents/` 2개, `skills/` 3개를 대상 플러그인의 동일 상대 레이아웃으로 복사.
2. **매니페스트 등록**: 대상 플러그인의 plugin.json에 이 스킬·에이전트가 자동 탐지되는지 확인 (Claude Code는 `skills/<name>/SKILL.md`·`agents/*.md` 표준 레이아웃 자동 인식).
3. **이름 충돌**: 대상 플러그인에 이미 `analyzer`·`wiki-builder` 에이전트나 `build-wiki`·`pair-init` 스킬이 있으면 이름을 바꾸고, SKILL.md 본문의 상호 참조(`Skill("build-wiki")`, `Skill("pair-init")`, `subagent_type="analyzer"`)를 함께 갱신한다.
4. **package.json scripts**: `test`·`index`·`build-wiki` 항목을 대상 플러그인 package.json에 병합 (없으면 이 패키지 것을 사용).
5. **`_workspace/` 산출물 충돌**: 대상 플러그인도 `_workspace/`를 쓰면 파일명 충돌 확인 — 이 패키지는 `00_init_scope.md`, `01_analyzer_report.md`, `03_validator_*`, `07/08_*wiki_report.md`, `api_drift_report.md`, `pair_refresh_result.json`, `ai-budget.json`, `index/`, `.index-cache/`를 사용한다.
6. **위키 제외 경로**: 대상 플러그인이 Codex 미러 등 생성물 폴더를 가지면 `build-wiki.mjs`의 `MARKDOWN_EXCLUDED_PREFIXES`에 해당 경로를 추가해 위키 문서 수집에서 제외한다.
7. **테스트**: `npm test` 10건 통과 확인 후 아래 스모크 절차 실행.

## 6. 스모크 테스트 절차 (이식 후 필수)

실제 프로젝트 사본 하나로 검증한다 (2026-07-23 fastapi-guide_new 사본으로 전 단계 검증 완료).

1. `node scripts/build-index.mjs --root <프로젝트> --mode init --tier Auto` → `_workspace/index/`에 `_meta.json`·`symbols.json`·`call_graph.json`·`_unresolved.jsonl` 생성 확인
2. `node scripts/query-index.mjs summary --root <프로젝트>` / `search --query <키워드>` 동작 확인
3. `node scripts/validate-harness.mjs --root <프로젝트> --index-only` → FAIL이 `FILE_MISSING`(00_init_scope·01_analyzer_report — AI 단계 산출물) 2건뿐인지, writer 계열 코드(`WRITER_*`/`PATTERN_MISSING`/`CLAUDE_SECTION`)가 없는지 확인
4. **스키마 경로 무결성**: `docs/index-schema/` 사본에서 스키마 하나를 `{"type":"array"}`로 바꾸고 `--plugin-root <사본>`으로 실행 → FAIL이 발생해야 정상 (안 나면 스키마가 로드되지 않고 조용히 통과 중)
5. `node scripts/build-wiki.mjs --root <프로젝트>` → `.claude/wiki/index.html`·`search-index.json`·`call-graph.html` 생성, `07_wiki_report.md`에서 `HTML 렌더링 PASS` + `서술 보강 MISSING`(경고일 뿐 빌드 성공) + `AI 호출 0회` 확인
6. (pair) 두 프로젝트에 1~5 반복 → 양쪽 `_workspace/pair_config.md` 기록 → `refresh-pair-index.mjs --backend --consumer` PASS → `build-wiki.mjs --backend <be> --frontend <fe>` → backend에만 위키 생성 + `api-contracts.html` 존재 + `08_system_wiki_report.md`의 `API 계약 PASS` 확인
7. (전체 흐름) 플러그인 설치 후 별도 세션에서 `index-init` 실행 — analyzer 1회 호출로 `01_analyzer_report.md` 생성 → validator `--index-only` PASS → `build-wiki` standard 모드에서 wiki-builder 1회로 `wiki-narrative.json` 생성 → 재렌더링 시 `서술 보강 PASS` 확인

## 7. 추출 원본 버전

- 원본: `Malburi/AX-Harness-wiki` — 로컬 v0.6.1 (commit `90e7a34` 시점, 2026-07-23 추출)
- 원본 변경 이력의 관련 항목: v0.5.0(토큰 강제·MJS 위키), v0.5.9(DB 관계·그래프), v0.6.0(초기화 구성 분류), v0.6.1(validator 계약 수리)
- 원본이 인덱서·위키 렌더러를 개선하면 이 패키지의 verbatim 파일들(1-1 표)을 다시 복사하고 `npm test`와 6장 스모크만 재실행하면 된다. 수정 파일(1-2 표)은 diff를 보고 수동 병합한다.
