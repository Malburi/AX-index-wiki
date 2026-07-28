---
name: build-wiki
description: 인덱스와 프로젝트 Markdown 전체를 결정적으로 렌더링하고, 기본 1회의 근거 기반 서술 보강으로 업무 이해·신규 담당자 온보딩·아키텍처 설명이 포함된 브라우저 위키·통합 검색·전체 호출 그래프를 생성한다. "위키 만들어줘", "업무 위키", "온보딩 위키", "아키텍처 설명서", "통합 위키", "콜그래프 시각화", "second brain", "위키 갱신" 요청 시 사용한다.
---

# Build Wiki

플러그인 `scripts/build-wiki.mjs`를 실행한다. HTML·검색 인덱스·그래프 데이터는 AI가 작성하지 않는다. AI는 구조화된 업무·온보딩·아키텍처 서술 JSON만 만들고 MJS가 file:line 근거와 최신성을 검증해 렌더링한다.

## 실행 환경

먼저 `../../docs/host-compatibility.md`를 읽는다. Node.js 실행이 실패하면 AI가 HTML을 대신 작성하지 말고 오류를 보고한다.

## 모드 결정

### 단일 저장소

```bash
node "[plugin-root]/scripts/build-wiki.mjs" --root "[project-root]"
```

출력:

- `[project-root]/.claude/wiki/`
- `[project-root]/_workspace/07_wiki_report.md`

홈은 프로젝트명·요약·주요 위험·기술 스택·분석 통계·도메인/기능 카드를 먼저 보여주는 GitHub 계열 dark dashboard다. 좌측 navigation은 시작하기·개발/품질·시스템 상세·도메인·저장소 트리로 구분하며 모든 상세 페이지에서 동일하게 유지한다.

다음 핵심 페이지는 항상 생성한다.

- 업무 이해: 사용자, 기대 결과, 업무 역량, 핵심 사용자 여정, 성공·실패 조건
- 신규 담당자 시작하기: 첫날·첫 주, 읽기 순서, 실행, 안전한 첫 작업, 디버깅 시작점
- 아키텍처: 구조적 책임, 대표 런타임 흐름, 시스템 경계, 설계 결정과 trade-off
- QA / 검증: validator 판정, manifest의 test/lint/check 명령, 테스트 파일·케이스, QA 보고서, 코드 커버리지 측정 여부

입력 데이터가 존재할 때 다음 상세 페이지를 조건부 생성한다.

- 개요·아키텍처·업무 워크플로우
- 데이터 모델·SQL·트랜잭션·외부 연동·테이블 관계도
- 코드 패턴 요약과 `.claude/patterns/*.md`별 상세 페이지·위험/미해결
- domain-expert의 도메인별 페이지
- 저장소별 evidence 페이지
- Git 추적 Markdown과 하네스 보고서의 문서 목차·개별 원문 페이지

## Markdown 수집 계약

- Git 저장소에서는 추적 중인 `.md`·`.mdx`를 개수 제한 없이 모두 수집한다.
- Git 저장소가 아니면 제외 경로 밖의 `.md`·`.mdx`를 재귀 수집한다.
- Git 비추적이어도 `CLAUDE.md`, `.claude/**/*.md`, `_workspace/**/*.md`는 수집한다.
- 생성 대상인 `07_wiki_report.md`·`08_system_wiki_report.md`는 순환 포함하지 않는다.
- `.git`, 의존성, 가상환경, cache/build 출력, `.claude/wiki`, `_workspace_prev`, 설치 플러그인 미러는 제외한다.
- 각 문서를 `pages/documents/<project>/<document>.html`로 만들고 `pages/documents.html`에서 저장소·분류별로 탐색한다.
- 문서 제목·원본 경로·본문·코드 식별자를 `search-index.json`에 넣는다. AI가 요약하거나 잘라내지 않는다.

## 산출물 완전성·표현 계약

- `pages/artifacts.html`을 항상 생성해 `_meta.json`, `_analysis_input.json`, `_unresolved.jsonl`, 9개 정규 index JSON과 수집한 Markdown 전체를 표로 나열한다.
- 각 index 행에는 존재 상태, 최상위 배열 레코드 수, 세부 배열별 개수, 실제 소비 위키 페이지 링크를 표시한다. 데이터가 0건이어도 행을 생략하지 않는다.
- Markdown은 `pages/documents.html`에서 프로젝트·분류별 표로 제공하고 원문별 HTML 페이지와 검색 항목을 만든다. Markdown 표는 실제 HTML `<table>`로, 코드 블록·목록·인용은 읽기 좋은 prose 스타일로 렌더링한다.
- 패턴은 `pages/conventions.html` 상단에 파일·file:line 근거 수·코드 예시 수 요약표를 두고, 아래에 각 문서 본문을 카드 형태로 연결한다.
- 각 패턴 문서는 `pages/patterns/<project>-<pattern>.html` 독립 페이지로도 렌더링하고 검색·좌측 트리에서 직접 연다.
- `pages/qa.html`은 명령의 존재와 실제 최신 실행 성공을 혼동하지 않는다. 코드 커버리지 측정 근거가 없으면 수치를 만들지 않고 `측정값 없음`을 명시한다.
- `_workspace/07_wiki_report.md`/`08_system_wiki_report.md`에도 index와 Markdown 인벤토리를 Markdown 표로 기록해 누락 여부를 기계·사람이 모두 확인할 수 있게 한다.

### pair 시스템

`_workspace/pair_config.md`가 있으면 설정이 서로를 가리키고 validator FAIL이 없는지 확인한다. 선택지를 묻지 않고 다음 명령 한 번만 실행한다. 이 명령은 내부에서 backend → 각 client → backend 증분 refresh와 API drift 재검증을 먼저 수행한 뒤 최신 인덱스로 위키를 렌더링한다. 별도 refresh 명령을 선행하지 않는다.

```bash
node "[plugin-root]/scripts/build-wiki.mjs" \
  --backend "[backend-root]" \
  --frontend "[frontend-root]"
```

백엔드 1개에 분리된 클라이언트가 여러 개(1:N)면 `--frontend`를 반복한다. backend `pair_config.md`의 `## 파트너 목록` 표에 있는 클라이언트를 전부 전달한다.

```bash
node "[plugin-root]/scripts/build-wiki.mjs" \
  --backend "[backend-root]" \
  --frontend "[web-root]" \
  --frontend "[mobile-root]"
```

desktop/mobile도 같은 `--frontend`를 쓴다. `--client`·`--consumer`는 호환 별칭으로만 허용하며 신규 안내와 사용자 화면에는 노출하지 않는다.

불변 계약:

- backend·client 로컬 위키를 따로 만들지 않는다.
- 정본은 `[backend-root]/.claude/wiki/` 하나다. 클라이언트가 몇 개든 위키는 1개다.
- client root에는 쓰지 않는다.
- 클라이언트마다 `pages/repositories/<client-id>.html`을 만들고, 한 클라이언트만 계약 미매칭이어도 종합 상태를 WARN으로 보고한다.
- node id는 `<project-id>::<original-id>`로 구분한다.
- `api_contract` edge로 client call → backend endpoint를 연결한다.
- FastAPI는 `include_router`의 import 대상, `APIRouter(prefix=...)`, 정적으로 확정 가능한 설정/f-string prefix와 route path를 합성한다.
- 양쪽 저장소의 Markdown을 동일한 문서 목차와 검색에 넣고 `project` namespace로 구분한다.
- 출력 보고서는 `[backend-root]/_workspace/08_system_wiki_report.md`다.

## 서술 보강 모드

먼저 MJS를 한 번 실행하고 보고서의 `narrative_status`를 확인한다.

- 기본(Standard): 일반적인 “위키 만들어줘” 요청이다. `narrative_status: PASS`면 기존 JSON을 재사용한다. `MISSING|STALE|WARN`이면 `wiki-builder`를 standard/Sonnet으로 정확히 한 번 호출하고 MJS를 다시 실행한다.
- 빠른(Fast): 사용자가 “AI 없이”, “그래프만”, “빠르게”라고 명시한 경우다. 에이전트를 호출하지 않는다. MJS가 업무·온보딩 페이지에 결정적 분석 원문 폴백과 서술 상태 경고를 표시한다.
- 심층(Deep): 사용자가 “심층 위키”, “인수인계 위키”, “아키텍처 심층 설명”을 요청한 경우다. `wiki-builder`를 한 번 호출하되 더 많은 업무 여정·설계 결정을 작성한다. HTML 생성 AI 호출은 추가하지 않는다.

에이전트는 정본 프로젝트의 `_workspace/wiki-narrative.json` 하나만 작성한다. 최대 60KB이며 schema version 2를 따른다. pair에서는 backend에만 쓴다. 모든 핵심 주장에 상대경로 `file:line` 근거를 붙이고 `_analysis_input.json.generated_at`을 `source_generated_at`에 기록한다.

## 완료 검증

다음을 확인한다.

- `.claude/wiki/index.html`
- `.claude/wiki/search.html`
- `.claude/wiki/search-index.json`
- `.claude/wiki/call-graph.html`
- `.claude/wiki/pages/coverage.html`
- `.claude/wiki/pages/artifacts.html`
- `.claude/wiki/pages/business.html`
- `.claude/wiki/pages/onboarding.html`
- `.claude/wiki/pages/qa.html`
- 패턴이 있으면 `.claude/wiki/pages/patterns/*.html`
- `.claude/wiki/pages/documents.html`과 문서별 HTML
- pair면 `.claude/wiki/api-contracts.html`
- 한국어 위키 생성 보고서의 생성 결과·서술 보강 검증·반영한 지식·생성 페이지·Index/Markdown 표 인벤토리와 기계 판정값 `render_status: PASS`, `narrative_status: PASS`, `narrative_evidence`, `analysis_coverage_status`, `api_contract_status`, `ai_calls`, `index_artifacts`, `markdown_documents`
- 기본/심층 모드에서 최종 `narrative_status`가 PASS가 아니면 위키 HTML 생성 성공과 별개로 서술 품질 경고를 사용자에게 보고한다.
- `analysis_coverage_status`가 `PARTIAL|WARN`이면 커버리지 페이지에 해당 확장자와 미지원 파일이 모두 표시되어야 하며 이를 PASS로 숨기지 않는다.
- pair의 endpoint·consumer가 존재하는데 연결이 없거나 consumer가 미매칭이면 overall `status: WARN`; 이를 성공으로 바꾸거나 숨기지 않는다.

품질 불변 조건:

- 모든 생성 페이지의 고정 navigation과 `/` 검색 단축키
- 좌측 navigation은 `시작하기 / 개발·품질 / 시스템 상세 / 도메인 / 저장소`의 native `<details>` 트리다. 저장 상태가 없는 최초 홈 화면에서는 모든 트리를 접어 둔다. 사용자가 펼친 상태는 저장하고, 상세 URL로 직접 진입했을 때만 현재 페이지의 조상 트리를 자동으로 연다. `localStorage`에는 트리 상태와 사이드바 `scrollTop`을 함께 저장해 페이지 이동 뒤 복원하고, 활성 메뉴가 복원된 viewport 밖에 있을 때만 `nearest`로 최소 보정한다. 페이지마다 메뉴를 맨 위로 초기화하지 않는다. 코드 패턴은 개발·품질 아래 한 단계 더 중첩한다.
- 프로젝트명·요약·기술 스택·주요 위험·coverage 통계를 한 화면에 보여주는 정보 밀도 높은 홈
- analyzer Markdown의 표·목록·코드·인용문을 원문 `<pre>`가 아니라 의미 있는 HTML로 렌더링
- camelCase·snake_case를 분리한 역색인과 제목 우선 가중치 검색
- 문서·심볼·SQL·테이블·API에서 실재 graph node로 연결되는 딥링크
- Git 추적 문서 전체와 하네스 지식·보고서가 문서 페이지 및 역색인에 누락 없이 존재
- 전체 graph node/edge 보존, 저장소 필터, 7종 시각 타입, 노드·엣지 다중 필터
- `call-graph.html`은 위키 좌측 navigation이나 일반 문서 레이아웃을 포함하지 않는 독립 그래프 전용 HTML로 생성한다. 위키의 모든 호출 그래프 링크는 이 파일을 새 창(`target=_blank`, `noopener noreferrer`)으로 연다.
- 호출 그래프 링크는 미리보기 호스트가 `target=_blank`를 무시할 때도 전용 `window.open`을 우선 시도하고, 팝업 차단 시 표준 새 탭 동작으로 fallback한다.
- 데이터 모델은 DDL `FOREIGN KEY`를 초록 실선 `DDL FK`, 실제 SQL의 컬럼 동등 조건을 노랑 점선 `SQL JOIN 추론`으로 구분한 인터랙티브 관계도를 제공한다. 관계선 클릭 시 테이블·컬럼·신뢰도·SQL ID·file:line·조건 근거를 표시하며, 논리 JOIN을 물리 FK로 과장하지 않는다.
- 노드 상세는 원본 식별자, file:line, signature, annotation, type/visibility/origin/confidence, 전체 outbound·inbound 이웃과 각 edge의 type·evidence·file:line을 표시하고 이웃 노드로 이동할 수 있어야 한다.
- analyzer의 `⚠ 인덱서 한계`는 정확한 심볼 식별자·`Class.method`·파일 경로/파일명이 근거 문장에 명시된 경우에만 해당 노드 상세에 연결한다. 심각도별 복합 문단은 개별 finding으로 분리하며, 전역 보안 위험·탐지 신뢰도·일반 dead-code 주의 문단을 노드 타입이나 in-degree만으로 연결하지 않는다.
- 단순 `in-degree=0`만으로 노드 배지·경고·미사용 표현을 표시하지 않는다. dead-code index도 `confidence: HIGH`와 별도 `evidence`가 모두 있을 때만 호출 그래프에 `근거 확인 미사용 후보`로 표시하고, LOW/MEDIUM 후보는 위험·분석 보고서에서만 제공한다.
- in-degree는 허브 강조에만 사용하고 미사용 판정에는 사용하지 않는다.
- pair의 client call → API contract → backend endpoint 연결과 request/response shape 표
- pair 위키 명령 한 번으로 증분 인덱스·계약 refresh·drift 판정·렌더링을 완료
- 구조화 index가 비어 있어도 analyzer에 DB/transaction/SQL/API/external/convention/risk 근거가 있으면 해당 페이지를 만들고 근거를 보존
- index와 analyzer 양쪽 모두에 근거가 없는 조건부 페이지만 만들지 않고 navigation에서도 제외

기존 client 저장소 위키가 있으면 자동 삭제하지 않고 오래된 중복 산출물로 안내한다.
