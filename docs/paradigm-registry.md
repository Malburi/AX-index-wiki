# Paradigm Registry — kind 정의

`_workspace/index/_meta.json.workspaces[].kind`에 올 수 있는 값과 그 공통 속성을 정의하는 단일 표. `docs/stack-matrix.md`가 "이 스택이 무엇인지 탐지하는 시그니처"를 다룬다면, 이 문서는 "그 스택이 속한 kind가 어떤 일반 속성을 갖는지"를 다룬다.

신규 파라다임(kind) 추가는 원칙적으로 **이 표에 행 하나 추가 + `docs/stack-matrix.md`에 탐지 시그니처 섹션 추가 + `agents/pattern-extractor.md`에 세트 섹션 추가**로 끝나야 한다. `agents/analyzer.md`·`agents/writer.md`·`agents/qa.md`·`skills/scaffold-feature/SKILL.md`는 kind 목록을 하드코딩하지 않고 이 표를 참조/순회하는 소비자로만 동작하므로 원칙적으로 무변경.

---

## kind 표

| kind | 표시명 | has_ui | calls_backend_api (기본값) | entry_point_concept | boundary_group | layer_role_names (기본 매핑) |
|------|--------|--------|---------------------------|----------------------|-----------------|-------------------------------|
| `backend` | 백엔드 | false | N/A (자신이 producer) | HTTP endpoint | request-response | Controller/Service/DAO/Entity |
| `frontend` | 프론트엔드 | true | true | route / route guard | request-response | Component/Store/APIClient |
| `desktop` | 데스크톱 | true | false (워크스페이스별 override) | Form/화면 진입(로그인 Form → 메인 Form 전환) | event-driven-ui (+ calls_backend_api:true 시 request-response) | Form-Presenter/Service/Repository |
| `mobile` | 모바일 | true | false (워크스페이스별 override) | Activity/Fragment 진입, 딥링크 | navigation (+ calls_backend_api:true 시 request-response) | Activity-Fragment/ViewModel/Repository/UseCase |

> 향후 kind 추가 예시(CLI, batch, embedded, WPF를 desktop과 분리하는 경우 등)는 이 표에 행을 추가하는 것으로 시작한다.

---

## 컬럼 설명

- **has_ui**: 사람이 조작하는 화면을 갖는가. analyzer Step 5(클라이언트 자원 탐지)류 로직을 이 kind에 적용할지 판정 근거.
- **calls_backend_api**: 이 kind가 `agents/analyzer.md` Step 8.5 API Contracts의 consumer 후보인가. `backend`는 항상 false(자신이 producer). `frontend`는 기본 true. `desktop`/`mobile`은 기본 false이며, 워크스페이스 인스턴스의 `calls_backend_api` 필드로 실측 override — 순수 로컬 앱(오프라인 유틸리티 등)과 백엔드 API를 호출하는 앱을 같은 kind 안에서 구분한다.
- **entry_point_concept**: `agents/analyzer.md` Step 14(인증/인가) 일반화에서 "보호해야 할 진입점"이 무엇인지 정의하는 용어.
- **boundary_group**: `docs/stack-matrix.md`의 "QA Boundary 원칙" 3계열(request-response / event-driven-ui / navigation) 중 이 kind가 기본으로 속하는 계열. 한 워크스페이스가 `calls_backend_api:true`이면 자신의 기본 계열 외에 request-response 계열 검증도 추가로 받는다(복수 계열 소속 가능).
- **layer_role_names**: `agents/analyzer.md` 리포트의 "아키텍처 레이어" 섹션(`[레이어명]` 플레이스홀더, 이미 동적)을 채울 때 참고하는 이 kind의 기본 레이어 이름. 강제 규칙이 아니라 힌트.

---

## 신규 kind 추가 절차

1. 이 표에 행 추가 (표시명·has_ui·calls_backend_api 기본값·entry_point_concept·boundary_group·layer_role_names 정의)
2. `docs/stack-matrix.md`에 탐지 시그니처 섹션 신설 + QA Boundary 세부 표에 이 kind의 스택 행 추가(boundary_group 매핑, 안 맞으면 그때 새 계열 추가)
3. `agents/pattern-extractor.md`의 "추출 대상 카테고리 세트" 레지스트리 표에 이 kind용 `paradigm_set` 행 추가 + 해당 세트 섹션(추출 항목 표) 작성
4. 그 외 `agents/analyzer.md`·`agents/writer.md`·`agents/qa.md`·`skills/scaffold-feature/SKILL.md`는 이 표와 pattern-extractor 레지스트리를 순회/참조하는 구조이므로 **수정 불필요**가 원칙 — 만약 수정이 필요해졌다면 해당 파일이 kind를 하드코딩하고 있다는 신호이니 그 부분을 이 레지스트리 참조로 리팩터링한다.
