# 호스트 호환성 계약

AX-Harness는 Claude Code, OpenAI Codex, Google Antigravity에서 **같은 입력·검증·산출물 계약**을 사용한다. 호스트마다 도구 이름, 에이전트 등록 방식, 모델 식별자가 다르므로 실행 문법까지 같다고 가정하지 않는다. 이 문서의 어댑터 규칙이 각 `SKILL.md`에 남아 있는 호스트별 예시 문법보다 우선한다.

## 1. 기능 감지 우선

호스트 이름이 아니라 현재 세션에 실제로 제공된 기능을 기준으로 실행한다.

1. 설치된 플러그인 기준 현재 `SKILL.md`에서 `../../agents/<name>.md`를 찾아 파일 전체를 읽는다. 대상 프로젝트 안의 `agents/`는 사용하지 않는다.
2. 호스트에 서브에이전트 위임 기능이 있으면 해당 에이전트 지침과 스킬이 정한 런타임 파라미터를 **호스트 네이티브 서브에이전트**에 전달한다.
3. 서로 독립적인 작업은 병렬 실행하고, 선행 산출물이 필요한 작업은 순차 실행한다.
4. 위임 기능이 없거나 정책상 비활성화되어 있으면 동일한 에이전트 지침을 현재 컨텍스트에서 순차 실행한다.
5. `Agent(subagent_type="...")`는 Claude Code용 예시다. Codex·Antigravity에서 이 문자열을 그대로 호출하지 말고 각 호스트의 네이티브 위임 기능으로 변환한다.

초기화 구성 질문은 모든 호스트에서 `현재 폴더 단일 / 현재 폴더 안 서버·클라이언트 / 서로 다른 폴더의 서버·클라이언트 / 특정 폴더·모듈`의 동일한 네 의미를 제공한다. 선택 UI가 최대 3개 옵션만 지원하면 특정 범위를 보조 선택으로 분리하되 `init_layout` 값은 동일하게 기록한다. 분리 저장소 `paired_init`에서는 backend와 실제 client kind(frontend/desktop/mobile) Lane을 각각 하나의 bounded task로 취급한다. 신규 프로젝트·workspace ID는 `root|backend|frontend|desktop|mobile`을 사용하고 generic `consumer` ID를 만들지 않는다. 네이티브 서브에이전트가 있으면 두 Lane을 병렬 실행하고, 없으면 같은 의존성 그래프를 순차 실행한다. 사용자가 승인한 두 절대경로 밖으로 읽기·쓰기 범위를 넓히지 않는다. 한 Lane 실패는 다른 Lane 산출물을 롤백하는 이유가 아니며 pair barrier만 PENDING으로 남긴다.

서브에이전트 유무는 성능과 컨텍스트 격리 방식만 바꾼다. `_workspace/` 경로, JSON·Markdown 스키마, 검증 기준, 안전 게이트는 바뀌지 않는다.

## 2. 진행 상태와 사용자 선택

- `TaskCreate` 같은 작업 추적 도구가 있으면 사용한다. 없으면 `_workspace/00_pipeline_status.md`의 체크리스트를 갱신한다.
- 사용자에게 보이는 작업·서브에이전트 제목은 `<내부 ID> · <agent/runtime> · <한글 작업 목적>` 형식을 사용한다. 예: `T-A · analyzer · 업무 흐름과 레거시 로직 분석`. 내부 ID나 `general-purpose`를 숨기지 말고, 일반 사용자가 이해할 수 있는 한글 설명을 반드시 함께 표시한다.
- 호스트가 전문 agent를 `general-purpose`로만 노출하면 `T-A · general-purpose/analyzer · 업무 흐름과 레거시 로직 분석`처럼 실제 agent 이름을 병기한다. 네이티브 작업 UI가 없어 체크리스트로 폴백해도 동일한 제목을 보존한다.
- 구조화된 사용자 선택 도구가 있으면 사용한다. 없으면 같은 선택지와 기본값을 일반 텍스트로 제시하고 응답을 기다린다.
- 스킬 호출 기능이 없으면 대상 `SKILL.md`를 완전히 읽고 현재 컨텍스트에서 동일한 절차를 수행한다.

## 3. 모델 정책

`agents/*.md` frontmatter의 `model: sonnet|opus`는 Claude Code의 선호 모델 힌트다. 다른 공급자의 모델 이름으로 해석하거나 존재하지 않는 모델 식별자를 만들어 전달하지 않는다.

| 논리 등급 | Claude Code | Codex·Antigravity 및 기타 호스트 |
|---|---|---|
| standard | `sonnet` 선호 | 현재 세션 또는 조직 정책이 승인한 기본 모델·기본 추론 수준 |
| deep | `opus` 선호 | 현재 세션 또는 조직 정책이 승인한 고성능 모델·높은 추론 수준(지원할 때만) |

호스트가 작업별 모델 override를 지원하지 않으면 활성 모델을 그대로 사용한다. 모델 선택 차이로 산출물 스키마나 완료 기준을 낮추지 않는다.

`harness-init`의 모델 계약은 호스트와 무관하게 동일하다. Lite/Standard analyzer와 모든 writer·qa·harness-evaluator는 `standard`, Full analyzer만 `deep`이다. `ai-budget.mjs`의 성공 claim 없이 에이전트를 호출하지 않는다. validator·pair API refresh·기본 위키 렌더링은 Node.js 결정적 스크립트이므로 모델을 호출하지 않는다. initial/reinitialize/update에서는 validator 통과 후 QA와 harness-evaluator를 순서대로 자동 실행한다. 위키는 필수 target의 QA·평가가 끝난 뒤 생성 여부를 한 번 확인하고, wiki-builder와 pattern-extractor는 명시 요청 없이 자동 연쇄 호출하지 않는다.

## 4. Hook 입력 계약

플러그인 Hook 명령은 `${PLUGIN_ROOT}` 같은 셸 변수 확장에 의존하지 않는다. Codex가 제공하는 `PLUGIN_ROOT`와 호환용 `CLAUDE_PLUGIN_ROOT`는 Node 프로세스 안에서 `process.env`로 읽어 Windows PowerShell·cmd와 Unix 셸에서 같은 설치 경로를 사용한다.

파일 작성 Hook은 다음 입력을 모두 허용한다.

- Claude 계열: `tool_input.file_path`, `tool_input.path`, `tool_response.file_path`
- Codex: `tool_name: "apply_patch"`와 `tool_input.command` 안의 `*** Add File:`, `*** Update File:`, `*** Delete File:` 헤더
- 기타 호스트: 위 직접 경로 필드 또는 `command`·`patch`·`input` 문자열 안의 동일 패치 헤더

Hook은 compact `_workspace/.runtime/<task-id>/task-state.json`을 검사하고 구형 `_workspace/safety_<slug>.md`도 하위 호환으로 허용한다. 한 번의 패치에 여러 판정이 있으면 `STOP > HOLD > GO` 우선순위로 가장 강한 값을 기록한다. 경로를 해석하지 못하거나 파일을 읽지 못해도 작업을 차단하지 않는다.

## 5. 호스트별 매핑

| 호스트 | 스킬 | 에이전트 위임 | Hook | AX-Harness 규칙 |
|---|---|---|---|---|
| Claude Code | 플러그인 스킬 | 이름 기반 Task/Agent | `Write`·`Edit` 계열 | `subagent_type` 예시를 그대로 사용할 수 있음 |
| OpenAI Codex | 플러그인 스킬 | Codex 네이티브 서브에이전트 | canonical `Write`가 `apply_patch`를 포함 | 에이전트 파일 지침을 네이티브 서브에이전트에 전달 |
| Google Antigravity | 플러그인 스킬 | 제공된 네이티브 위임 기능 | 직접 경로 또는 패치 payload | 기능이 없으면 인라인 순차 실행 |

지원 수준은 두 단계로 구분한다.

- **계약 검증**: 매니페스트, 미러, 스킬 참조, Hook payload, 산출물 계약을 저장소 테스트로 검증한다.
- **런타임 검증**: 실제 호스트 버전과 조직 정책에서 설치·트리거·위임·Hook 실행을 smoke test한다. 호스트 업데이트 후에는 이 단계를 다시 수행한다.

Codex의 현재 동작 기준은 공식 문서의 [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Hooks](https://learn.chatgpt.com/docs/hooks), [Plugin building](https://developers.openai.com/codex/plugins/build)을 따른다. 특히 Codex Hook의 canonical `Write` 이벤트는 `apply_patch`를 포함하지만, AX-Harness는 다른 호스트와 독립 테스트를 위해 matcher와 payload 파서를 모두 명시적으로 지원한다.
