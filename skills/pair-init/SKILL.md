---
name: pair-init
description: 각각 인덱스 초기화와 validator 검증을 마친 별도 backend(server)·frontend/desktop/mobile(client) 프로젝트를 양방향으로 연결한다. "백엔드 프론트엔드 연결해줘", "페어 설정", "pair init", "두 프로젝트 연동", "API 계약 추출해줘", "크로스리포 설정", "파트너 프로젝트 등록", "외부 저장소 연결해줘" 요청 시 트리거. `index-init`의 분리 저장소 모드에서는 양쪽 초기화 barrier 통과 후 자동 호출된다.
---

# Pair Init (오케스트레이터)

분리된 두 저장소를 인덱스 레벨에서 연동해 *실시간 API 계약 검증·통합 시스템 위키*를 활성화한다. 이 스킬은 프로젝트 초기화를 대신하지 않는다. 권장 진입점은 한쪽 저장소에서 `index-init`을 한 번 실행해 양쪽 초기화를 완료하는 것이다.

연동 후에는 `refresh-pair-index.mjs`가 API 계약과 드리프트를 결정적으로 갱신하고,
`build-wiki`가 양쪽을 합친 단일 시스템 위키를 backend `.claude/wiki/`에 생성한다.

`_workspace/pair_config.md`가 이 연동의 정본이며, `scripts/refresh-pair-index.mjs`와
`scripts/build-wiki.mjs`(pair 모드)가 이 파일을 참조한다.

---

## 🔧 실행 환경 호환성

이 스킬의 입출력 계약은 Claude Code·Codex·Antigravity에서 동일하다. 실행 전 `../../docs/host-compatibility.md`를 완전히 읽고, 에이전트 위임과 사용자 선택 도구의 폴백 규칙을 적용한다.

---

## Phase 0: 사전 확인

### 현재 프로젝트 확인

`pwd`로 현재 루트 파악. `_workspace/pair_config.md` 존재 확인:
- 이미 있으면 현재 설정 내용을 보여주고 재설정 여부를 사용자에게 확인.

### 양쪽 하네스·validator 확인

현재 프로젝트와 파트너 프로젝트 각각에서 다음을 확인한다.

- `_workspace/index/_meta.json` 존재
- `_workspace/03_validator_result.json` 존재하고 status가 PASS 또는 WARN (index-only 모드 결과 허용)

하나라도 없으면 pair 파일을 쓰지 않고 중단한다. 단독 호출이면 "현재 프로젝트에서 '인덱스 초기화'(`index-init`)를 실행하고 분리 저장소를 선택하면 양쪽을 한 번에 초기화한 뒤 연결합니다"라고 안내한다. `post_dual_init: true` 호출도 검증 자체는 생략하지 않고, 전달받은 barrier 결과와 실제 파일을 대조한다.

---

## Phase 1: 프로젝트 쌍 정보 수집

`index-init` Step 2.6에서 이미 partner 경로를 수집해 전달한 경우 이 Phase는 스킵하고 Phase 2로 직행(중복 질문 방지). 그 외(단독 호출)에는 한 번에 묻는다:

```
AskUserQuestion(
  questions=[{
    question: "페어 설정에 필요한 서버·클라이언트 역할을 선택해주세요.",
    header: "페어 설정",
    multiSelect: false,
    options: [
      { label: "Backend (Server)", description: "이 프로젝트가 API를 제공하는 서버입니다." },
      { label: "Frontend / Desktop / Mobile (Client)", description: "이 프로젝트가 백엔드 API를 호출하는 클라이언트입니다. 구체적인 kind는 다음 질문에서 확인합니다." }
    ]
  }]
)
```

"frontend / desktop / mobile" 선택 시 후속 질문으로 정확한 kind를 확인(`docs/paradigm-registry.md`의 kind 표 기준 — frontend/desktop/mobile 중 선택, 향후 kind가 레지스트리에 추가되면 이 선택지도 함께 늘어난다). 이어서:

```
1. 파트너 프로젝트 절대 경로:
   (예: C:\work\my-frontend 또는 /home/user/my-frontend)
2. API base URL (로컬 개발 기준, 선택):
   (예: http://localhost:8080 — 모르면 빈칸)
3. (선택) 파트너 스택: (예: Vue 3, WinForms, Android — 모르면 빈칸)
```

### 파트너 경로 유효성 확인

PowerShell: `Test-Path "[파트너 경로]"` 또는 bash: `[ -d "[파트너 경로]" ]`

- 경로 없음 → "경로를 확인해주세요" 안내 후 재입력 요청.
- 파트너 하네스 또는 validator 결과 없음 → 연결 중단. 반쪽 설정이나 계약 추출만 수행하는 degraded 연결은 기본 제공하지 않는다.

---

## Phase 2: pair_config.md 양방향 원자적 생성

두 파일의 최종 내용을 먼저 메모리에서 만들고 기존 파일이 있으면 내용을 보존한다. 각 `_workspace/`에 세션별 임시 파일(`pair_config.md.tmp-[session]`)을 쓴 뒤 필수 필드·역방향 경로를 검증한다. 두 임시 파일 검증이 모두 성공해야 최종 `pair_config.md`로 rename한다.

한쪽 rename 또는 쓰기가 실패하면 이미 교체한 쪽을 이전 내용으로 복원하고 양쪽 임시 파일을 제거한다. **한쪽에만 새 설정이 남는 반쪽 연결은 허용하지 않는다.**

### 현재 프로젝트 최종 내용

`_workspace/pair_config.md`:

```markdown
# Pair Configuration

project_type: [backend/frontend/desktop/mobile]
partner_type: [backend/frontend/desktop/mobile]
partner_root: [절대경로]
partner_workspace: [절대경로]/_workspace
partner_stack: [파트너 스택 — 미입력 시 unknown]
api_base_url: [http://localhost:8080 — 미입력 시 unknown]
api_contract_path: _workspace/index/api_contracts.json
partner_api_contract: [파트너 절대경로]/_workspace/index/api_contracts.json
system_wiki_owner: backend
system_wiki_root: [backend 절대경로]/.claude/wiki
linked_at: [YYYY-MM-DD]
```

필드는 `scripts/refresh-pair-index.mjs`와 `scripts/build-wiki.mjs`(pair 모드)가 참조하는 표준 형식이다 — 필드명을 임의로 바꾸지 않는다.

### 백엔드 1개 : 클라이언트 N개(1:N)

한 백엔드에 분리된 클라이언트가 둘 이상이면 backend 쪽 `pair_config.md`에 단수 `partner_*` 필드 대신 **파트너 목록 표**를 기록한다. 각 클라이언트 쪽은 단수 필드로 backend 하나만 가리키므로 형식이 그대로다.

```markdown
# Pair Configuration

project_type: backend
system_wiki_owner: backend
system_wiki_root: [backend 절대경로]/.claude/wiki
linked_at: [YYYY-MM-DD]

## 파트너 목록

| id | type | root | api_contract | stack |
|---|---|---|---|---|
| frontend | frontend | [절대경로] | [절대경로]/_workspace/index/api_contracts.json | Vue 3 |
| mobile | mobile | [절대경로] | [절대경로]/_workspace/index/api_contracts.json | Android |
```

- `id`는 `frontend|desktop|mobile` 같은 실제 역할을 쓰고 중복되지 않게 한다.
- 단수 `partner_root:`와 표를 함께 쓰면 단수 필드가 첫 파트너로 취급되고 표의 나머지가 추가된다(경로 중복은 자동 제거).
- 표만 쓰는 1:N 설정도 단수 필드만 쓰는 기존 1:1 설정도 모두 동작한다.
- 클라이언트를 추가할 때는 표에 행을 추가하고 새 클라이언트 쪽에 역방향 단수 설정을 만든 뒤 Phase 3를 다시 실행한다. 기존 클라이언트 설정은 건드리지 않는다.

### 파트너 프로젝트 최종 내용 (역방향)

같은 스키마에서 `project_type`/`partner_type`, `partner_root`/상대 계약 경로를 뒤집어 기록한다. `system_wiki_owner`와 `system_wiki_root`는 양쪽에서 동일하게 backend의 `.claude/wiki/`를 가리킨다. pair 위키는 저장소별로 만들지 않고 이 정본 위치에만 생성한다. 파트너 쓰기 권한이 없으면 Phase 0에서 중단했어야 하며, 이 단계에서 현재 프로젝트만 저장하고 계속 진행하지 않는다.

---

## Phase 3: 결정적 API 계약·드리프트 갱신 (AI 호출 없음)

양방향 `pair_config.md` 기록이 끝나면 플러그인 루트의 스크립트를 실행한다.

```bash
node "[plugin-root]/scripts/refresh-pair-index.mjs" \
  --backend "[backend 절대경로]" \
  --frontend "[frontend|desktop|mobile 절대경로]"
```

클라이언트가 여러 개(1:N)면 `--frontend`를 반복한다.

```bash
node "[plugin-root]/scripts/refresh-pair-index.mjs" \
  --backend "[backend 절대경로]" \
  --frontend "[web 절대경로]" \
  --frontend "[mobile 절대경로]"
```

`--consumer`·`--client`는 같은 옵션의 하위 호환 별칭이다. 사용자 질문·프로젝트 ID·작업 제목·결과 보고에서는 실제 역할인 `frontend|desktop|mobile`을 사용한다.

스크립트는 다음 순서를 지킨다.

1. backend incremental index — 로컬 endpoint 계약 생성
2. 각 client incremental index — backend 계약을 읽어 클라이언트 호출과 전수 매칭
3. backend incremental index — 모든 client 계약을 역방향 반영
4. client별 `_workspace/api_drift_report.md`와 `pair_refresh_result.json` 기록
5. backend `_workspace/api_drift_summary.md`와 `pair_refresh_result.json`에 클라이언트별 표와 종합 판정 기록

`pair_config.md`의 파트너 목록에 없는 클라이언트를 인자로 주면 실행은 되지만 `undeclared_clients`로 보고되므로 표에 추가해야 다음 실행에서 자동 인식된다.

기존 `_ai_patch.json`은 incremental 인덱싱에서 유효 node에만 다시 적용한다. API 계약 추출과 drift 검증에 AI 에이전트를 호출하지 않는다 — 전 과정이 결정적이다.

실패하면 pair 설정은 유지하되 상태를 `LINKED_WITH_DRIFT_UNKNOWN`으로 보고하고 같은 스크립트 재실행 명령을 안내한다.

---

## Phase 4: CLAUDE.md "파트너 프로젝트" 섹션 갱신 (조건부)

**기존 `CLAUDE.md`가 있는 프로젝트에만** 아래 섹션을 추가/갱신한다. CLAUDE.md가 없으면 이 Phase를 생략한다(이 플러그인은 CLAUDE.md를 새로 만들지 않는다).

```markdown
## 파트너 프로젝트 ([상대방 kind])

- 파트너 경로: [절대경로]
- 스택: [스택]
- API 계약: `_workspace/index/api_contracts.json` (엔드포인트 [N]개)
- 연동일: [YYYY-MM-DD]

### 크로스 리포 워크플로우
| 상황 | 명령 |
|------|------|
| API 드리프트 재확인·계약 갱신 | "API 드리프트 확인해줘" → 결정적 pair refresh |
| 시스템 위키 생성·갱신 | "양쪽이 함께 나오는 시스템 위키 만들어줘" → build-wiki (`system_wiki_root` 단일 정본) |
```

파트너 쪽 CLAUDE.md 수정 권한이 없으면 현재 프로젝트만 갱신하고 "파트너 CLAUDE.md는 수동으로 추가 필요" 안내.

---

## Phase 5: 결과 보고

```
페어 설정 완료 (토폴로지: 1:1 | 1:N — 클라이언트 [N]개)

Backend:  [경로] ([스택])
Client:   [경로] ([frontend|desktop|mobile] / [스택])
          ... 클라이언트마다 한 줄
API base: [url]

API 계약 추출: [성공/실패]
  엔드포인트: N개 (공개 A개 | 인증 B개)
  저장: [백엔드]/_workspace/index/api_contracts.json

API 드리프트 검증: [실행됨/스킵]  종합 [PASS|WARN]
  | 클라이언트 | 상태 | endpoint | 호출 | 매칭 | 미매칭 |
  ... refresh 결과의 클라이언트별 행을 그대로 표시
  클라이언트별 상세: [client]/_workspace/api_drift_report.md
  종합 요약: [백엔드]/_workspace/api_drift_summary.md

이제 가능한 작업:
  "시스템 위키 만들어줘"     → build-wiki (모든 클라이언트를 합친 단일 위키, backend 정본)
  "API 드리프트 다시 확인"   → 결정적 pair refresh (refresh-pair-index.mjs)
```

미매칭이 있는 클라이언트는 어느 쪽인지 반드시 이름과 함께 보고한다. 1:N에서 한 클라이언트만 WARN이어도 종합 상태는 WARN이며, 정상 클라이언트를 근거로 전체를 PASS로 보고하지 않는다.

---

## 에러 핸들링

| 상황 | 대응 |
|------|------|
| 파트너 경로 접근 불가 | 연결 시작 전 중단. 기존 pair_config가 있으면 유지하고 신규 반쪽 설정은 만들지 않음 |
| 결정적 pair refresh 실패 | pair 설정 유지 + `LINKED_WITH_DRIFT_UNKNOWN`, 재실행 명령 안내 |
| 파트너 CLAUDE.md 수정 권한 없음 | 현재 프로젝트만 갱신, 파트너 쪽은 수동 안내 |
| `pair_config.md` 이미 존재 | 재설정 여부 사용자 확인 후 진행 |
| 두 임시 pair_config 중 한쪽 기록/rename 실패 | 변경된 쪽 복원 + 임시 파일 제거 + 연결 PENDING 보고 |
