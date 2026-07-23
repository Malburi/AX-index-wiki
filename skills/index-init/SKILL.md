---
name: index-init
description: 프로젝트 전체를 결정적 인덱서로 전수 색인하고, 필요한 의미 분석만 AI(analyzer 1회)에 맡겨 `_workspace/index/` JSON 인덱스와 근거 기반 분석 보고서를 생성한다. "인덱스 초기화", "인덱스 만들어줘", "프로젝트 색인해줘", "index init", "인덱스 갱신", "validator만 다시" 요청 시 사용한다.
---

# 인덱스 초기화 — 근거 중심·토큰 제한

## 목표

레거시 유지보수와 위키 생성에 필요한 **전체 기계 커버리지 + 근거 기반 의미 분석**을 만든다.

- 전수 수집: `scripts/build-index.mjs` (AI 토큰 0)
- 의미 분석: analyzer 1회 (Full만 deep/Opus, 나머지 standard/Sonnet)
- 구조·근거 검증: `scripts/validate-harness.mjs --index-only` (AI 토큰 0)
- 분리 저장소 연결·API drift: `scripts/refresh-pair-index.mjs` (AI 토큰 0)

초기화 1개 target의 기본 AI 호출은 **정확히 1회(analyzer)**다. 결정적 검증 실패 시 구체적인 실패 항목만 최대 1회 보완한다. 이 플러그인은 CLAUDE.md·도메인 문서·패턴 문서를 생성하는 writer 단계를 포함하지 않는다 — 산출물은 인덱스 JSON과 analyzer 분석 보고서이며, 이후 `build-wiki`가 이를 위키로 렌더링한다.

## 호스트 호환성

실행 전 `../../docs/host-compatibility.md`를 완전히 읽는다. 아래 `Agent`, `TaskCreate`, `AskUserQuestion`은 Claude Code 예시다. Codex·Antigravity에서는 같은 입출력·모델 논리 등급·의존성을 호스트 네이티브 기능으로 변환한다. 위임 기능이 없으면 에이전트 지침을 현재 컨텍스트에서 순차 실행한다.

---

## Phase -1: 초기화 구성·범위 확인 (Init Scope Gate — AI 호출 없음)

초기화는 개발 명세를 묻는 단계가 아니다. **프로젝트 배치 형태와 분석 범위**만 확정한다. 저장소 구성을 뒤에서 다시 묻지 않도록 최초 질문에서 단일 프로젝트·한 폴더 멀티워크스페이스·분리 프로젝트를 명시적으로 구분한다.

### 질문

기존 `_workspace/00_init_scope.md`가 없고 사용자가 구성을 명시하지 않은 최초 실행에서만 한 번 묻는다. 질문 전에 현재 작업 폴더의 절대경로를 표시한다.

```text
초기화할 프로젝트 구성을 선택해주세요.
현재 작업 폴더: [absolute current directory]

1. 현재 폴더를 하나의 프로젝트로 초기화 (Recommended)
   - 지금 폴더 전체를 단일 프로젝트로 분석합니다.
2. 현재 폴더 안의 서버·클라이언트를 함께 초기화
   - 한 상위 폴더 안의 backend와 frontend/desktop/mobile을 워크스페이스로 통합 분석합니다.
3. 서로 다른 폴더의 서버·클라이언트를 각각 초기화 후 연결
   - 두 프로젝트를 독립적으로 초기화하고 양쪽 검증 후 pair-init으로 연결합니다.
4. 현재 폴더의 특정 폴더·모듈만 초기화
   - 선택한 상대경로만 분석합니다.
```

호스트의 선택 UI가 최대 3개 옵션만 지원하면 4번을 별도의 `특정 범위` 보조 선택으로 제공하되, 사용자에게 보이는 의미와 아래 `init_layout` 값은 동일해야 한다.

| 사용자 선택 | `init_layout` | 후속 확인 | 실행 형태 |
|---|---|---|---|
| 현재 폴더를 하나의 프로젝트로 초기화 | `single-root` | 없음 | 현재 root의 단일 Lane |
| 현재 폴더 안의 서버·클라이언트를 함께 초기화 | `monorepo` | root 내부 workspace 상대경로와 역할 | 한 root, `workspace_mode: true` |
| 서로 다른 폴더의 서버·클라이언트를 각각 초기화 후 연결 | `paired-roots` | 양쪽 절대경로·역할·Read/Write 권한 | 두 독립 Lane → validator barrier → pair-init |
| 현재 폴더의 특정 폴더·모듈만 초기화 | `selected-paths` | root 내부 상대경로 | 현재 root의 제한된 단일 Lane |

선택 후에는 필요한 경로만 후속 확인한다. 휴리스틱으로 발견한 `server`, `backend`, `client`, `frontend`, `web`, `mobile` 후보는 경로 확인 표의 제안값으로만 사용하며 사용자의 구성 선택을 자동으로 바꾸지 않는다. 사용자가 요청문에 구성과 경로를 이미 명시했다면 질문을 생략하고 `source: explicit-request`로 기록한다. 기존 scope에 `init_layout`이 없으면 구형 설정을 임의 변환하지 않고 이 구성 질문을 한 번 수행해 마이그레이션한다.

초기화에서는 다음을 **질문하지 않는다**.

- 제외하거나 보안상 읽지 않을 경로
- Lite/Standard/Full 분석 깊이
- 사용 목표·우선순위·레거시 특이사항

Tier는 결정적 인덱서가 의존성·가상환경·빌드 산출물을 제외한 실제 소스 기준으로 자동 결정한다. 사용자가 요청문에 `빠르게|quick`, `심층|Full`, `마이그레이션`을 직접 명시한 경우만 override한다.

### 출력

`_workspace/00_init_scope.md`를 일반 파일 쓰기로 기록한다.

```markdown
# 초기화 분석 범위

## 사용자 확인 내용
- 프로젝트 위치: `[absolute path]`
- 초기화 구성: 현재 폴더 단일 | 현재 폴더 안 서버·클라이언트 | 분리된 서버·클라이언트 | 특정 폴더·모듈
- 분석 범위: 전체 프로젝트 | 선택한 폴더·모듈
- 포함 경로: `[검증된 상대경로]`
- 대상 프로젝트: `[절대경로와 역할 목록]`
- 워크스페이스: `[상대경로와 역할 목록, 해당 없으면 root]`
- 범위 확정 방식: 사용자 선택 | 요청문에 명시 | 이전 설정 재사용

## 기계 실행 값
- project_root: [absolute path]
- init_layout: single-root | monorepo | paired-roots | selected-paths
- target_roots: [{root, role}]
- analysis_scope: full | selected
- paths: [검증된 상대경로]
- workspace_mode: true | false
- workspaces: [{id, path, kind, calls_backend_api}]
- source: user-selection | explicit-request | reused

## 초기화 원칙
- 개발·수정 작업 명세는 이 단계에서 만들지 않음
- 의존성·가상환경·빌드 산출물은 결정적 인덱서 기본 규칙으로 제외
- 실제 Tier는 인덱싱 후 소스 규모와 복잡도 신호로 자동 결정
```

`monorepo`와 `selected-paths`의 포함 경로는 root 내부의 실제 디렉터리만 허용한다. `..`와 root 밖 절대경로는 거부한다. 전체 범위는 `paths: [.]`이다. `paired-roots`의 두 절대경로는 각각 실제 프로젝트 root여야 하며 서로 같거나 한쪽이 다른 쪽의 하위 경로이면 분리 프로젝트로 처리하지 않는다. `00_init_scope.md`는 paired 양쪽 root에 같은 `init_layout`과 `target_roots`를 기록하되 각 파일의 `project_root`는 해당 root로 기록한다.

---

## Phase 0: 대상·안전 상태 확인

### Step 1: 실행 모드

| 조건 | mode |
|---|---|
| 인덱스 없음 | initial |
| "다시", "새로" | reinitialize |
| "인덱스만", "인덱스 갱신" | index-refresh |
| "validator만", "위키만" | partial |

`index-refresh`는 결정적 인덱서 incremental을 실행하고 unresolved가 있을 때만 analyzer를 1회 호출한다. `partial`은 요청된 단계만 실행한다.

### Step 2: 기존 산출물 선백업

initial/reinitialize에서 기존 산출물이 있으면 먼저 백업한다.

- 대상: 기존 `.claude/wiki/`
- 위치: `.claude/backup/[YYYYMMDD-HHmmss]/`

재초기화에서는 기존 `_workspace/00_init_scope.md`와 `_workspace/pair_config.md`를 메모리에 보존하고 `_workspace/`를 `_workspace_prev/[YYYYMMDD-HHmmss-fff]/`로 이동한다. 새 `_workspace/` 생성 후 두 파일을 원래 경로로 복원한다. 과거 `_workspace_prev/` 이력은 삭제하지 않는다.

### Step 2.5: 초기화 구성 적용

여기서는 저장소 구성을 다시 질문하지 않는다. Phase -1의 `init_layout`을 실행 설정으로 변환한다.

- `single-root`: `workspace_mode: false`, root workspace 1개, `include_paths: ["."]`.
- `monorepo`: 확인한 각 workspace의 `id/path/kind/stack/calls_backend_api`를 기록하고 `workspace_mode: true`로 실행한다. 서버·클라이언트가 같은 상위 root에 있으므로 `pair-init`을 호출하지 않는다.
- `paired-roots`: 각 root는 `workspace_mode: false`인 독립 프로젝트로 준비하고 Step 2.6의 dual-init으로 이동한다.
- `selected-paths`: `workspace_mode: false`, 확인한 상대경로를 `include_paths`로 사용한다.
- 재실행/partial/index-refresh: `00_init_scope.md`의 `init_layout`과 `_meta.json`의 workspace 값을 재사용한다. 두 값이 충돌하면 조용히 추측하지 않고 경로 표를 보여주고 다시 확인한다.

### Step 2.6: 분리 저장소 단일 명령·양쪽 초기화 준비

`paired-roots`를 선택한 경우 backend(server) root와 client(frontend/desktop/mobile) root의 절대경로, 각 역할, 양쪽 Read/Write 권한을 확인한다. 현재 작업 폴더가 반드시 한쪽 root라는 가정은 하지 않는다. 경로와 기존 인덱스 상태를 표로 보여주고 한 번 승인받는다.

승인 후 메모리에만 다음 객체를 보존한다. 이 단계에서 `pair-init`을 호출하지 않는다.

```json
{
  "paired_init": true,
  "initiator_root": "...",
  "projects": [
    {"id":"backend","root":"...","role":"backend"},
    {"id":"frontend","root":"...","role":"frontend"}
  ],
  "pair_state": "PENDING"
}
```

각 root는 자체 `_workspace/`를 가진다. `index-init`을 파트너 서브에이전트에서 재귀 호출하지 않는다.

신규 초기화의 프로젝트·workspace ID는 역할을 그대로 사용한다. 단일 프로젝트는 `root`, 서버는 `backend`, 웹 클라이언트는 `frontend`, 데스크톱은 `desktop`, 모바일은 `mobile`이다. `consumer`는 API 계약 스키마의 `consumers[]` 같은 내부 용어에만 허용하고, 신규 `target_roots`·`workspaces[].id`·작업 제목·사용자 보고에는 ID나 역할명으로 쓰지 않는다.

### Step 2.7: Tier·호출 예산

Tier는 Phase 2-0 인덱서 실행 후 `_workspace/index/_meta.json.complexity`에서 확정된다.

| Tier | analyzer |
|---|---|
| Lite | standard/Sonnet, 구조 요약 |
| Standard | standard/Sonnet, 조건부 의미 분석 |
| Full | **deep/Opus, 레거시 의미·전체 unresolved 판정** |

Full을 명시한 경우 실행 전 다음 비용 정보를 알리되 Tier 선택 질문은 하지 않는다.

```text
[target 수]개 저장소 Full 초기화: Opus analyzer [target 수]회.
위키는 완료 후 생성 여부를 한 번 확인합니다 (기본 위키는 AI 0회).
```

---

## Phase 1: 작업 그래프

### 단일/모노레포

```text
T-I · MJS · 소스 구조와 호출 관계 인덱싱
 -> T-A · analyzer · 업무 흐름과 레거시 로직 분석
 -> T-V · MJS validator · 인덱스와 분석 근거 전수 검증 (--index-only)
 -> WIKI-ASK · 위키 생성 여부 확인
```

### 분리 저장소

```text
B-I -> B-A -> B-V --\
                     P-BARRIER -> P-PAIR -> P-REFRESH -> WIKI-ASK
C-I -> C-A -> C-V --/
```

| ID | 사용자에게 표시할 제목 |
|---|---|
| B-I | `B-I · MJS · [백엔드] 소스 구조와 API 엔드포인트 인덱싱` |
| B-A | `B-A · analyzer · [백엔드] 서비스·DB 업무 흐름 분석` |
| B-V | `B-V · MJS validator · [백엔드] 분석 결과 검증` |
| C-I | `C-I · MJS · [프론트엔드/데스크톱/모바일] 화면과 API 호출 구조 인덱싱` |
| C-A | `C-A · analyzer · [프론트엔드/데스크톱/모바일] 화면에서 API까지 호출 흐름 분석` |
| C-V | `C-V · MJS validator · [프론트엔드/데스크톱/모바일] 분석 결과 검증` |
| P-BARRIER | `P-BARRIER · 양쪽 저장소 검증 결과 확인` |
| P-PAIR | `P-PAIR · 프론트엔드와 백엔드 양방향 연결` |
| P-REFRESH | `P-REFRESH · API 계약과 미매칭 호출 갱신` |
| WIKI-ASK | `WIKI-ASK · 초기화 결과 확인 후 위키 생성 여부 질문` |

- 같은 단계의 두 Lane은 병렬 실행할 수 있다.
- 각 Lane 내부 `I -> A -> V` 순서는 유지한다.
- `P-BARRIER`: 양쪽 결정적 validator PASS/WARN 확인
- 한 Lane이 실패하면 성공 Lane은 보존하고 `pair_state: PENDING`으로 둔다.
- 실패 Lane만 재개하며 성공 Lane을 다시 분석하지 않는다.

`TaskCreate`가 있으면 위의 내부 ID와 한글 설명을 **함께 포함한 제목 그대로** 작업을 생성한다. 호스트가 전문 agent 이름 대신 `general-purpose`만 표시하면 `T-A · general-purpose/analyzer · 업무 흐름과 레거시 로직 분석`처럼 실제 agent 이름과 한글 목적을 description에 함께 넣는다. `_workspace/00_pipeline_status.md` 체크리스트로 폴백할 때도 같은 제목을 사용한다.

아래 Agent 예시의 `[task-id]`와 `[project-role]`은 호출 전에 반드시 실제값으로 치환한다. 단일/모노레포는 `T-A`이며 역할 접두사를 생략하고, 분리 저장소는 `B-A`와 `[백엔드]` 또는 `C-A`와 실제 client kind(`[프론트엔드]`, `[데스크톱]`, `[모바일]`)를 사용한다. 대괄호 placeholder나 `T-A|B-A|C-A` 같은 선택지를 사용자 제목에 그대로 노출하지 않는다.

보완·재검증 작업 제목은 원래 단계 ID를 보존한다.

- `T-A-RETRY · analyzer · 누락된 호출 관계와 분석 근거 보완`
- `T-V-RECHECK · MJS validator · 보완된 초기화 결과 재검증`

---

## Phase 2: 실행

### 2-0. 결정적 전수 인덱싱

각 target에 `_workspace/indexer-config.json`을 기록한다.

`workspaces[].id`는 `root|backend|frontend|desktop|mobile` 중 실제 역할과 일치하는 값을 쓴다. 모노레포의 서버·웹 클라이언트 예시는 각각 `backend`, `frontend`이며 generic `consumer` ID를 만들지 않는다.

```json
{"init_layout":"single-root","include_paths":["."],"workspace_mode":false,"workspaces":[{"id":"root","path":"","kind":"unknown","stack":"unknown"}]}
```

플러그인 루트의 스크립트를 사용한다.

```bash
node "[plugin-root]/scripts/build-index.mjs" \
  --root "[project-root]" \
  --mode "[init|incremental]" \
  --tier "[Auto|Lite|Standard|Full]" \
  --config "_workspace/indexer-config.json"
```

`Auto`는 `.git`, `node_modules`, vendor, build/dist/target, `.venv`, venv, site-packages, cache, `_workspace`, `.claude`를 제외하고 실제 소스 수와 DB/legacy/module/external signal로 Tier를 결정한다.

생성물:

- `_workspace/index/_meta.json` — coverage, complexity, budget
- `_workspace/index/_analysis_input.json` — analyzer용 작은 입력 팩
- `_workspace/index/symbols.json`, `call_graph.json`, 조건부 SQL/API/transaction/external/env/schema/dead-code
- `_workspace/index/_unresolved.jsonl` — 후보가 2개 이상인 관계 전부
- `_workspace/.index-cache/` — hash 캐시

Lite도 `symbols.json`·`call_graph.json`·`_meta.json`을 생성한다. 200은 총 처리 한도가 아니라 한 배치 크기이며 모든 unresolved를 EOF까지 처리한다.

Node 실행 실패 시 1회 재시도한다. 재실패하면 AI가 전체 JSON을 대신 작성하도록 폴백하지 않고 해당 Lane을 중단한다. 결정적 기반 없이 분석을 계속하면 비용과 환각이 동시에 증가하기 때문이다.

각 Lane은 인덱싱 직후 이번 실행에서 유일한 `[init-session-id]`로 강제 예산을 초기화한다. 같은 session 재개는 기존 사용량을 보존한다.

```bash
node "[plugin-root]/scripts/ai-budget.mjs" init \
  --root "[project-root]" --session "[init-session-id]" --initial 1 --retries 1
```

이후 AI 에이전트는 반드시 호출 **직전** `claim`에 성공해야 한다. 명령이 비정상 종료하면 해당 호출을 실행하지 않는다.

### 2-1. analyzer — 의미 분석 전용

부분 재실행에서 유효한 `01_analyzer_report.md`가 있으면 스킵한다.

| Tier | mode | logical model |
|---|---|---|
| Lite | lite | standard |
| Standard | init | standard |
| Full | init | deep |

```bash
node "[plugin-root]/scripts/ai-budget.mjs" claim \
  --root "[project-root]" --session "[init-session-id]" --role analyzer --kind initial
```

```text
Agent(
  subagent_type="analyzer",
  description="[task-id] · analyzer · [project-role] 업무 흐름과 레거시 로직 분석",
  prompt="project_root: [absolute]
  tier: [Lite|Standard|Full]
  mode: [lite|init|incremental]
  analysis_input: _workspace/index/_analysis_input.json
  query_tool: [plugin-root]/scripts/query-index.mjs
  unresolved: _workspace/index/_unresolved.jsonl (200건 이하 배치로 EOF까지 전부)
  output: _workspace/01_analyzer_report.md
  constraints: 대형 index 직접 Read 금지, 전체 소스 재순회 금지, 모든 자연어 보고는 한국어, 단순 요약 금지, 모듈 책임·업무 흐름·데이터·연동·위험 상세 기록, 모든 의미 주장 file:line, _analysis_input.pattern_candidates 전수 검토, 다중 후보를 단일 패턴으로 축약 금지, Pattern Evidence category마다 실제 소스 3~20줄 코드 예시 필수",
  model="[standard|deep]"
)
```

target당 신규 호출 1회다. Full에서만 deep/Opus를 사용한다. `_ai_patch.json`이 있으면 다음 명령으로 병합한다.

```bash
node "[plugin-root]/scripts/build-index.mjs" --root "[project-root]" --apply-ai-patch "_workspace/index/_ai_patch.json"
```

### 2-3. 결정적 validator (index-only)

```bash
node "[plugin-root]/scripts/validate-harness.mjs" \
  --root "[project-root]" \
  --plugin-root "[plugin-root]" \
  --tier "[Lite|Standard|Full]" \
  --index-only
```

출력:

- `_workspace/03_validator_result.json`
- `_workspace/03_validator_report.md`

검증기는 모든 index 항목을 스키마로 전수 검사하고, 그래프 참조·AI edge 근거·실제 파일 경로·Full evidence 밀도·unresolved 보고·analyzer 보고서의 한국어 상세 섹션·Pattern Evidence의 실제 코드 예시를 검사한다. `--index-only`는 이 플러그인이 생성하지 않는 writer 문서(CLAUDE.md·patterns 등) 검사만 생략한다.

FAIL이면 result의 code로 담당을 정한다.

- `SCOPE_*` -> AI 호출 없이 오케스트레이터가 `00_init_scope.md` 한국어 템플릿만 다시 기록
- `PLUGIN_INDEX_CONTRACT` -> 인덱서가 생성한 값과 플러그인 스키마가 충돌한 자체 결함이다. analyzer를 재호출하지 않고, 설치 캐시도 직접 수정하지 않는다. 성공한 분석 산출물을 보존하고 pair 상태를 PENDING으로 둔 뒤 플러그인 정본 수정·버전 업데이트를 요구한다. 업데이트 후 MJS 인덱싱과 validator만 재실행한다.
- `INDEX_*`, `GRAPH_*`, `AI_EVIDENCE`, `UNRESOLVED_*`, `EVIDENCE_DENSITY`, `ANALYZER_*`, `PATTERN_CATEGORY_COVERAGE` -> analyzer를 실패 항목만 1회 resume/재호출
- 보완 후 validator 1회 재실행

담당 에이전트 보완 호출 직전 아래 gate를 통과해야 한다. `[validator-code]`에는 실제 FAIL code를 넣는다. `PLUGIN_INDEX_CONTRACT`에는 이 gate나 AI 보완 호출을 사용하지 않는다.

```bash
node "[plugin-root]/scripts/ai-budget.mjs" claim \
  --root "[project-root]" --session "[init-session-id]" \
  --role analyzer --kind retry --reason "[validator-code]"
```

target당 보완 호출은 최대 1회다. gate가 거부하거나 재검증도 FAIL이면 완료로 포장하지 않고 해당 Lane을 중단한다.

### 2-4.5. 분리 저장소 검증 barrier -> pair-init -> 결정적 API refresh

`paired_init: true`에서만 실행한다.

1. 양쪽 `_workspace/03_validator_result.json`이 FAIL이 아닌지 확인한다.
2. 한쪽 실패 시 성공 Lane은 보존하고 `pair_state: PENDING`; 연결하지 않는다.
3. 양쪽 통과 후에만 pair 설정을 원자적으로 기록한다.

```text
Skill("pair-init",
  input="post_dual_init: true
  backend_root: [...]
  consumer_root: [...]
  skip_questions: true
  deterministic_refresh: true")
```

4. `pair-init`이 양방향 `pair_config.md`를 기록한 뒤 내부에서 다음 스크립트를 한 번 실행해 backend -> consumer -> backend 순서의 incremental 인덱스를 재사용한다.

```bash
node "[plugin-root]/scripts/refresh-pair-index.mjs" \
  --backend "[backend-root]" \
  --consumer "[consumer-root]"
```

이 명령은 실패 복구용 직접 재실행 형식이기도 하다. API endpoint/consumer/match와 `_workspace/api_drift_report.md`를 생성한다. 오케스트레이터가 `pair-init` 완료 후 같은 명령을 중복 실행하면 안 된다.

### 2-6. 위키 결정

모든 필수 target의 validator(및 pair refresh)가 끝난 뒤, 후속 작업 질문은 위키 생성 여부만 한 번 묻는다. 필수 target이 `PENDING`이면 위키 질문을 하지 않고 재개 지점을 보고한다.

```text
인덱스 초기화를 완료했습니다.
현재 결과: [target별 validator PASS|WARN, score]

프로젝트 위키와 호출 그래프를 지금 생성할까요?
1. 예 — build-wiki로 생성
2. 아니오 — 초기화 결과만 유지
```

- `예`: `Skill("build-wiki")`를 실행한다. pair는 backend 정본 위치에 시스템 위키 1개만 생성한다.
- `아니오`: 위키를 만들지 않고 완료 보고한다.
- 사용자가 초기 요청에 위키 생성까지 명시했다면 질문을 생략하고 바로 `build-wiki`를 실행한다.
- 기본 위키는 MJS 렌더링 경로라 AI 0회다. 설명형 서술 보강을 명시한 경우에만 wiki-builder 1회를 사용한다.

---

## Phase 3: 완료 보고

사용자에게 한 번 전달한다.

```text
인덱스 초기화 완료

- target / Tier / 실제 소스 파일 수
- 결정적 인덱스: symbols N, graph nodes N/edges N, SQL/API/transaction/external counts
- AI 호출: analyzer 1회([standard|deep]), targeted retry N회
- AI 예산 증적: `_workspace/ai-budget.json`의 session·claim·remaining
- Full coverage: indexed N/N, unresolved total/resolved/remaining, file:line evidence count
- validator: PASS|WARN (index-only), score, 경고
- pair: linked|PENDING, API matched/unmatched
- 위키: 생성 완료 | 사용자가 생성하지 않음 | 필수 target PENDING으로 질문 보류
```

"완벽 분석"이라고 표현하지 않는다. 대신 기계 커버리지, 의미 근거, unresolved, 런타임에서만 확인 가능한 영역을 분리해 보고한다.

---

## 재실행·갱신

### 인덱스 갱신

1. `build-index.mjs --mode incremental --tier [기존 tier]`
2. hash가 바뀐 파일만 재분석
3. `_unresolved.jsonl`이 비면 AI 호출 없이 종료
4. 항목이 있으면 analyzer incremental 1회가 모든 배치를 처리
5. 기존 `_ai_patch.json`은 incremental에서 유효 node만 재적용

### validator만

`validate-harness.mjs --index-only`만 실행한다. AI 호출 없음.

### 위키만

`build-wiki` 스킬만 실행하고 초기화 파이프라인을 재실행하지 않는다.

---

## 실패 정책

| 실패 | 처리 |
|---|---|
| indexer 2회 실패 | AI 직접 JSON 폴백 금지, Lane 중단 |
| analyzer 미생성 | 1회 resume; 재실패 시 중단 |
| validator FAIL | code 기반 targeted retry 최대 1회 |
| paired 한쪽 실패 | 정상 Lane 보존, pair_state PENDING |
| pair 원자적 기록 실패 | 이전 양쪽 설정 유지, 반쪽 연결 금지 |
| deterministic API refresh 실패 | pair 설정은 유지하되 drift 미검증 WARN |

사용량 한도에 도달하면 완료로 표시하지 않는다. 마지막 성공 checkpoint와 재개할 task를 보고한다.
