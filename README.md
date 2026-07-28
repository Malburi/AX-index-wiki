# AX-Index-Wiki

**AX-Harness에서 추출한 결정적 인덱스 생성 + 근거 기반 프로젝트 위키 플러그인.**

레거시 프로젝트를 AI 토큰 없이 전수 색인해 `_workspace/index/` JSON 인덱스를 만들고, 이를 브라우저 위키(`.claude/wiki/`)와 인터랙티브 호출 그래프로 렌더링한다. AI는 의미 분석(analyzer 1회)과 선택적 서술 보강(wiki-builder 1회)에만 제한적으로 사용한다.

## 구성

| 구분 | 항목 | 역할 |
|------|------|------|
| 스킬 | `index-init` | 인덱스 초기화 오케스트레이터 (MJS 인덱싱 → analyzer 1회 → MJS validator) |
| 스킬 | `build-wiki` | 인덱스 → 브라우저 위키 + 호출 그래프 + 페이지 내 검색 (기본 AI 0회) |
| 스킬 | `pair-init` | 분리 저장소(backend/client) 양방향 연결 + API 계약·드리프트 결정적 검증 |
| 에이전트 | `analyzer` | 결정적 인덱스 기반 의미·위험·패턴 판정, unresolved AI edge patch |
| 에이전트 | `wiki-builder` | 선택적 서술 보강 전용 — 작은 `wiki-narrative.json`만 생성 |
| 스크립트 | `scripts/build-index.mjs` | 무의존성 결정적 인덱서 (`_meta`·symbols·call_graph·SQL·API·transaction·external·env·schema·dead-code). DB 관계는 **1:1·1:N·N:1·N:M 다중성까지** 근거와 함께 판정 |
| 스크립트 | `scripts/query-index.mjs` | 대형 JSON을 직접 읽지 않도록 bounded 조회 (summary/unresolved/search) |
| 스크립트 | `scripts/validate-harness.mjs` | 인덱스 스키마·그래프 무결성·file:line 근거 검증. **`--index-only`** 모드 지원 |
| 스크립트 | `scripts/refresh-pair-index.mjs` | backend→각 client→backend 증분 refresh + 클라이언트별 API drift 보고 (백엔드 1개 : 클라이언트 N개 지원) |
| 스크립트 | `scripts/build-wiki.mjs` | 단일/pair 위키·검색·호출 그래프를 AI 0회 렌더링 |
| 스크립트 | `scripts/ai-budget.mjs` | session별 AI 호출 예산(initial 1 + retry 1) 강제 |

모든 스크립트는 **npm 의존성 0** — Node.js 내장 모듈만 사용한다 (Node 18+).

## 설치 (Claude Code)

```
/plugin marketplace add <이 저장소 경로 또는 GitHub 주소>
/plugin install AX-Index-Wiki
```

## 사용

| 요청 | 실행 |
|------|------|
| "인덱스 초기화" | `index-init` — 구성 질문 1회 → MJS 인덱싱 → analyzer → validator(--index-only) → 위키 생성 여부 질문 |
| "위키 만들어줘" | `build-wiki` — 기본 AI 0회, "설명 보강해줘" 명시 시 wiki-builder 1회 |
| "두 프로젝트 연동해줘" | `pair-init` — 양쪽 인덱스 검증 후 pair_config 원자적 기록 + API drift 검증 |
| "인덱스 갱신" | `build-index.mjs --mode incremental` — hash가 바뀐 파일만 재분석 |

직접 실행 (AI 없이 결정적 경로만):

```bash
node scripts/build-index.mjs --root <project> --mode init --tier Auto
node scripts/query-index.mjs summary --root <project>
node scripts/validate-harness.mjs --root <project> --index-only
node scripts/build-wiki.mjs --root <project>                          # 단일
node scripts/build-wiki.mjs --backend <be> --frontend <fe>            # pair 1:1 (backend에 단일 정본 위키)
node scripts/build-wiki.mjs --backend <be> --frontend <web> --frontend <mobile>   # pair 1:N
```

## DB 관계와 다중성

관계는 근거 종류를 섞지 않고 세 갈래로 추출하며, **다중성은 근거가 있을 때만** 확정한다 — 없으면 추정하지 않고 `다중성 미확정`으로 남긴다.

| 근거 | 다중성 판정 |
|---|---|
| **DDL FK** (`CREATE TABLE ... FOREIGN KEY`) | 자식 쪽 FK 컬럼이 PK·`UNIQUE` 제약·`UNIQUE INDEX`로 덮이면 **1:1**, 아니면 **N:1** |
| **ORM 매핑** (JPA·SQLAlchemy·Django·TypeORM·Sequelize) | 애노테이션이 다중성을 직접 표현 — `@OneToOne`→1:1, `@OneToMany`→1:N, `@ManyToOne`→N:1, `@ManyToMany`→N:M. DDL이 없는 프로젝트도 관계 확보 |
| **SQL JOIN 추론** (`alias.col = alias.col`) | 양쪽 컬럼의 유일성 조합으로 판정. 한쪽 테이블 DDL이 없으면 미확정 |

**N:M**은 조인 테이블(FK 2개 이상의 컬럼 합집합이 유일한 테이블)에서 파생해 별도로 기록하며, 물리 FK 선언 자체는 각각 N:1로 그대로 남긴다. 위키 데이터 모델 페이지가 다중성 배지·판정 근거·N:M 섹션·관계 종류별 필터를 함께 렌더링한다.

## 저장소 토폴로지

- **단일** — `--root`
- **모노레포** — 한 root 안 여러 workspace (`workspace_mode`)
- **분리 1:1** — backend + client 1개
- **분리 1:N** — backend 1개 + 분리된 client N개(웹+모바일 등). backend `pair_config.md`의 `## 파트너 목록` 표로 선언하고, 클라이언트별로 API drift를 분리 보고한다. 한 클라이언트만 미매칭이어도 종합 상태는 WARN이며 위키는 backend 한 곳에만 생성된다.

백엔드가 2개 이상인 구성은 하나의 pair로 묶지 않는다 — 각각 별도 초기화 대상이다.

## 원본과의 차이

AX-Harness 전체 파이프라인에서 **인덱스 생성과 위키 생성만** 추출했다. writer(CLAUDE.md·도메인 문서·패턴 문서 생성)·qa·harness-evaluator·작업용 에이전트(impact-analyzer 등)·hooks는 포함하지 않는다. 이에 따라:

- validator는 `--index-only`로 실행해 writer 산출물 검사를 생략한다 (analyzer 보고서 품질 검사는 유지).
- 위키의 업무 서술은 `01_analyzer_report.md`와 선택적 `wiki-narrative.json`이 원천이다. CLAUDE.md·patterns가 프로젝트에 이미 있으면 위키에 추가 반영된다(없어도 동작).
- 초기화 AI 예산은 target당 1회(analyzer) + validator FAIL 보완 1회다.

추출 근거와 다른 플러그인 병합 절차는 [`docs/extraction-guide.md`](docs/extraction-guide.md) 참고.

## 검증

```bash
npm test   # 15건 — build-index 7, validate-harness index-only 3, 관계·다중성·1:N 5
```

## 출처

[Malburi/AX-Harness-wiki](https://github.com/Malburi/AX-Harness-wiki) v0.6.1에서 추출. MIT License.
