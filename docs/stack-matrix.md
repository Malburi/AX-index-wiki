# Stack Matrix — 지원 스택 매트릭스

AX-Harness가 자동 탐지/지원하는 스택 목록과 각 스택에서의 분석/QA 깊이.

## 지원 수준을 읽는 법

이 문서의 `HIGH|MEDIUM|LOW`는 analyzer가 적용할 의미 분석·QA 깊이다. 파일 파서가 모든 프레임워크 동작을 완전히 재현한다는 뜻은 아니다. 실제 초기화 결과는 `_workspace/index/_meta.json.adapter_coverage`와 위키의 **분석 커버리지** 페이지가 최종 판정한다.

| 결정적 수준 | 대표 대상 | 보장 범위 |
|---|---|---|
| `FULL` | Java/Kotlin, JavaScript/TypeScript/Vue, FastAPI Python, C#, Go, SQL | 심볼·호출·API·SQL·주요 진입점을 MJS로 전수 수집 |
| `PARTIAL` | JSP/JSPX/tag, Struts XML, Classic ASP, ASP.NET markup/Razor, XAML, Django/Flask 중첩 라우팅, PHP/Ruby, COBOL/ABAP | 기본 심볼·화면/이벤트·route·SQL을 수집하고 필요한 파일만 analyzer가 의미 보강 |
| `WARN` | Oracle Forms `fmb`, PowerBuilder `pbl`, 전용 리포트 등 바이너리/전용 형식 | 존재와 경로만 전수 보고; 텍스트/XML/source export를 추가해야 내부 로직 분석 가능 |

웹이 아닌 WinForms/WPF/배치/콘솔은 HTTP route 대신 UI 이벤트·Command·scheduler·`Main` 같은 trigger를 진입점으로 인덱싱한다. pair 연동은 Retrofit·HttpClient·Refit·RestSharp 등 consumer가 실제 backend API를 호출할 때만 적용하며, 독립형 C# 프로그램도 단일 프로젝트 분석 대상으로 정상 처리한다.

---

## 탐지 시그니처

analyzer Step 1~2 에서 다음 파일/문자열로 자동 탐지:

### Java 계열

| 스택 | 탐지 시그니처 | 분석 깊이 |
|------|------------|---------|
| Maven Java | `pom.xml` | HIGH |
| Gradle Java | `build.gradle`, `build.gradle.kts` | HIGH |
| Spring Boot 2/3 | `pom.xml` + `spring-boot-starter-*` | HIGH |
| Spring Framework 3~4 | `pom.xml` + `spring-*` (no boot) | MEDIUM (레거시 패턴 다수) |
| Struts 1.x | `pom.xml` + `org.apache.struts:struts-core` 또는 `WEB-INF/struts-config.xml` | HIGH (마이그레이션 대상) |
| Struts 2.x | `pom.xml` + `org.apache.struts:struts2-core` | HIGH |
| Java EE Web | `WEB-INF/web.xml` | MEDIUM |
| EJB 2.x | `WEB-INF/web.xml` + `ejb-jar.xml` | LOW (레거시, 마이그레이션 대상) |
| MyBatis | `mybatis-spring`, `mybatis-config.xml`, `*Mapper.xml` | HIGH |
| iBatis (레거시) | `ibatis-sqlmap`, `sqlmap-config.xml` | MEDIUM (마이그레이션 대상) |
| JPA / Hibernate | `spring-data-jpa`, `hibernate-*`, `persistence.xml` | HIGH |
| 전자정부 표준프레임워크 | `org.egovframe` 또는 `egovframework.*` | MEDIUM |
| JSP/JSTL | `*.jsp`, `WEB-INF/jsp/*` | MEDIUM |

### Node.js 계열

| 스택 | 탐지 | 깊이 |
|------|------|------|
| Express | `package.json` + `express` | HIGH |
| NestJS | `@nestjs/core` | HIGH |
| Next.js | `next` + `next.config.*` | HIGH |
| Fastify | `fastify` | MEDIUM |
| Koa | `koa` | MEDIUM |
| TypeORM | `typeorm` | HIGH |
| Prisma | `prisma` + `schema.prisma` | HIGH |
| Sequelize | `sequelize` | MEDIUM |
| Mongoose | `mongoose` | MEDIUM |

### 프런트엔드 (SPA/SSR)

| 스택 | 탐지 | 깊이 |
|------|------|------|
| Vue 3 | `package.json` + `vue@^3`, `*.vue` SFC, `<script setup>` | HIGH |
| Vue 2 | `package.json` + `vue@^2`, Options API | MEDIUM (마이그레이션 대상) |
| Nuxt 3 | `nuxt@^3` + `nuxt.config.ts`, `app.vue`, `pages/` | HIGH |
| Nuxt 2 | `nuxt@^2` + `nuxt.config.js` | MEDIUM (마이그레이션 대상) |
| Pinia | `pinia` | HIGH |
| Vuex | `vuex` | MEDIUM (Pinia 마이그레이션 대상) |
| Vue Router | `vue-router` | HIGH |
| Vite | `vite.config.*` + `vite` | HIGH |
| Vue CLI (webpack) | `vue.config.js` + `@vue/cli-service` | MEDIUM (Vite 마이그레이션 대상) |
| React | `react`, `react-dom` | HIGH |
| Angular (15+) | `@angular/core`, `angular.json` | HIGH |
| AngularJS (1.x) | `angular@^1`, `ng-app` | LOW (마이그레이션 대상) |
| Svelte / SvelteKit | `svelte`, `@sveltejs/kit` | MEDIUM |

### Python 계열

| 스택 | 탐지 | 깊이 |
|------|------|------|
| FastAPI | `fastapi` in requirements/pyproject | HIGH |
| Django | `django` | HIGH |
| Flask | `flask` | MEDIUM |
| SQLAlchemy | `sqlalchemy` | HIGH |
| psycopg | `psycopg` 또는 `psycopg2` | MEDIUM |
| Pydantic | `pydantic` | HIGH |

### .NET 계열

| 스택 | 탐지 | 깊이 |
|------|------|------|
| .NET Framework 2~4 | `*.csproj` + `<TargetFramework>net4*` or `v4.*` | MEDIUM (마이그레이션 대상) |
| .NET Core / 5~8 | `*.csproj` + `<TargetFramework>net[5-8].*` or `netcoreapp*` | HIGH |
| ASP.NET Core | `Microsoft.AspNetCore.*` | HIGH |
| Entity Framework | `EntityFramework`, `Microsoft.EntityFrameworkCore` | HIGH |
| Classic ASP.NET MVC | `System.Web.Mvc` | MEDIUM (마이그레이션 대상) |

### Desktop (Windows Forms / DevExpress)

| 스택 | 탐지 시그니처 | 분석 깊이 | paradigm |
|------|------------|---------|----------|
| WinForms | `*.csproj` + `<UseWindowsForms>true</UseWindowsForms>` 또는 `System.Windows.Forms` 참조 | HIGH | desktop |
| DevExpress WinForms | `DevExpress.XtraEditors`/`DevExpress.XtraGrid` 등 참조 | HIGH | desktop |
| WPF (참고 — 현재는 desktop kind에 포함, 필요 시 별도 kind 분리 후보) | `*.csproj` + `<UseWPF>true</UseWPF>` | MEDIUM | desktop |
| HttpClient / RestSharp / Refit (백엔드 연동) | 해당 참조 존재 시 `calls_backend_api: true` 판정 근거 | — | desktop |
| 로컬 DB | `System.Data.SQLite`, `Microsoft.Data.Sqlite`, `LiteDB` | HIGH | desktop |

### Mobile (Android)

| 스택 | 탐지 시그니처 | 분석 깊이 | paradigm |
|------|------------|---------|----------|
| Android (Kotlin/Java) | `AndroidManifest.xml` + `build.gradle(:app)` | HIGH | mobile |
| Jetpack Compose | `androidx.compose.*` 의존성 | HIGH | mobile |
| XML Layout (View 기반) | `res/layout/*.xml` + `findViewById`/`ViewBinding` | HIGH | mobile |
| Room | `androidx.room:room-*` | HIGH | mobile |
| Jetpack Navigation | `androidx.navigation:navigation-*`, `nav_graph.xml` | HIGH | mobile |
| ViewModel/LiveData/Flow | `androidx.lifecycle.*` | HIGH | mobile |
| Retrofit (백엔드 연동) | `retrofit2:retrofit`, `@GET`/`@POST` 인터페이스 → `calls_backend_api: true` 판정 근거 | HIGH | mobile |

### 데이터베이스

| DB | 탐지 | 깊이 |
|----|------|------|
| Oracle | `ojdbc*`, `oracle.jdbc.*`, `*.pkb`/`*.pks` (PL/SQL) | HIGH |
| PostgreSQL | `postgresql-*`, `pg`, `psycopg` | HIGH |
| MySQL / MariaDB | `mysql-connector-*`, `mariadb-java-client`, `mysql2` | HIGH |
| SQL Server | `mssql-jdbc`, `System.Data.SqlClient`, `tedious` | MEDIUM |
| Tibero (한국) | `tibero-jdbc`, `com.tmax.tibero.jdbc` | MEDIUM |
| Altibase (한국) | `altibase-jdbc` | LOW |
| MongoDB | `mongo-java-driver`, `mongoose`, `motor` | MEDIUM |
| Redis | `jedis`, `redisson`, `redis-py`, `ioredis` | MEDIUM |

### 기타/레거시

| 스택 | 탐지 | 깊이 |
|------|------|------|
| Go | `go.mod` | MEDIUM |
| Rust | `Cargo.toml` | MEDIUM |
| PHP / Laravel | `composer.json`, `laravel/framework` | LOW |
| Ruby on Rails | `Gemfile`, `rails` | LOW |
| COBOL | `*.cbl`, `*.cob` | LOW (legacy-decoder 적용) |
| ABAP (SAP) | `*.abap`, ABAP 패턴 | LOW (legacy-decoder 적용) |
| Oracle Forms | `*.fmb`, `*.frm` | LOW |
| Classic VB | `*.vbp`, `*.frm` (구) | LOW |

---

## 분석 깊이 의미

| 깊이 | 의미 |
|------|------|
| HIGH | 7-step + Phase B 심층 분석 + Boundary 1~4 모두 활용 가능 |
| MEDIUM | 7-step + Phase B 일부. Boundary 일부 적용. 컨벤션 추출 가능 |
| LOW | 구조 파악 + 기본 컨벤션. 심층 분석 제한적. legacy-decoder 우선 권장 |

---

## QA Boundary 원칙 (paradigm 계열별)

모든 Boundary 1(진입점 ↔ 호출자 정합성)은 아래 3계열 중 하나로 환원된다. 신규 스택/파라다임 추가 시 새 계열을 만들기보다 이 3계열 중 하나에 매핑을 먼저 시도하고, 안 맞을 때만 계열을 추가한다.

| boundary_group | 정의 | 대표 스택 | 짝(pair) |
|-----------------|------|----------|---------|
| request-response | 명시적 요청→응답 (HTTP, RPC) | Spring Boot, Express, FastAPI, Next.js, Vue/React(프론트 fetch), WinForms(HttpClient, `calls_backend_api:true` 시), Android(Retrofit, `calls_backend_api:true` 시) | endpoint(producer) ↔ consumer(호출자, kind 무관) |
| event-driven-ui | UI 이벤트 핸들러 ↔ 트리거 소스 | WinForms/DevExpress(Button.Click 등 Designer.cs 이벤트 배선) | handler ↔ trigger(위젯/컨트롤) |
| navigation | 화면/경로 전환 | Vue Router, Next.js, Android Navigation Component, WinForms(Form.Show()/MDI) | destination ↔ navigator(전환을 발생시키는 코드) |

각 워크스페이스의 kind는 `docs/paradigm-registry.md`의 `boundary_group` 기본값을 따르되, `calls_backend_api:true`인 워크스페이스는 자신의 기본 계열 외에 request-response 계열 검증도 추가로 받는다(복수 계열 소속 가능 — 예: Android는 기본 navigation이면서 Retrofit 사용 시 request-response도 겸함).

## QA Boundary 매트릭스 (스택별 세부 정의)

스택별 적용되는 4-Boundary (Boundary 5, 6은 모든 스택 공통):

| 스택 | boundary_group | Boundary 1 | Boundary 2 | Boundary 3 | Boundary 4 |
|------|-----------------|----------|----------|----------|----------|
| Java EE / Struts | request-response | Struts XML ↔ Service ↔ Bean | Service ↔ Query XML 양방향 | 스킬 주장 ↔ 코드 | forward ↔ JSP |
| Spring Boot | request-response | `@RequestMapping` ↔ 프론트 호출 | `@Entity` ↔ DTO shape | `@Repository` ↔ 호출 위치 | 트랜잭션 전파 ↔ Service 호출 그래프 |
| Express/NestJS | request-response | route path ↔ 클라이언트 fetch | 응답 shape ↔ 프론트 타입 | middleware 체인 일관성 | DTO ↔ ORM 모델 |
| FastAPI | request-response | `@router` path ↔ 클라이언트 호출 | Pydantic ↔ ORM 필드 | DI 그래프 | status code ↔ 응답 schema |
| Next.js | request-response + navigation | `app/[route]` ↔ `href` | API 응답 shape ↔ `fetchJson<T>` | 서버 컴포넌트 fetch ↔ 클라이언트 hook | status 전이 |
| Vue 3 / Nuxt 3 | request-response + navigation | `pages/` 또는 router 경로 ↔ `<NuxtLink>`/`router.push` | `defineProps`/`<script setup>` 타입 ↔ API 응답 shape | Pinia store action ↔ 컴포넌트 호출 | composable (`use*`) 의존 그래프 |
| Vue 2 / Nuxt 2 | request-response + navigation | `routes.js` 경로 ↔ `<router-link>` | `props`/Options API 타입 ↔ API 응답 | Vuex action/mutation ↔ 컴포넌트 dispatch | mixin ↔ 사용 컴포넌트 |
| .NET Core MVC | request-response | `[Route]` ↔ 호출 | EF Entity ↔ DTO | Repository ↔ 호출 위치 | DbContext ↔ Migration |
| WinForms/DevExpress | event-driven-ui (+ request-response 시) | Designer.cs 이벤트 배선(`this.button1.Click += ...`) ↔ 실제 핸들러 메서드 존재. `calls_backend_api:true`면 추가로: HttpClient/RestSharp 호출 ↔ backend 엔드포인트(`api_contracts.json`) | ViewModel/BLL ↔ backend 응답 shape (calls_backend_api:true 시) 또는 로컬 DB 스키마 | Repository/DAL ↔ 호출 위치 | DevExpress GridView 등 데이터바인딩 ↔ ViewModel/BLL 필드 |
| Android (Retrofit/Navigation) | navigation (+ request-response 시) | `nav_graph.xml`/AndroidManifest destination ↔ `navigate()`/Intent 호출. `calls_backend_api:true`면 추가로: `@GET`/`@POST` Retrofit interface ↔ backend 엔드포인트(`api_contracts.json`) | data class(DTO) ↔ backend 응답 shape (calls_backend_api:true 시) 또는 Room Entity | Repository ↔ ViewModel 호출 | ViewModel(LiveData/StateFlow) ↔ Fragment/Activity 바인딩 |

새 스택 발견 시 qa.md의 "스택별 boundary 검증 변형" 섹션에 stub 추가(위 원칙 표의 3계열 중 매핑 우선).

> **통합/paired 계약이 활성화될 때**, 위 표의 Boundary 1은 `_workspace/index/api_contracts.json` 기반 정합성 검증으로 확장/대체된다. 모노레포는 `workspace_mode:true`, 분리 저장소는 각 root의 `workspace_mode:false` + 양쪽 `pair_config.md`를 사용한다. backend+frontend에 한정하지 않고 `calls_backend_api:true`인 consumer kind(desktop/mobile 포함)의 호출 시그니처를 `consumers[]`로 흡수한다. 상세: `agents/qa.md`와 `docs/index-spec.md`.

---

## 워크스페이스 구성 판정 (모노레포/분리 저장소, N-paradigm)

harness-init Phase 2.5에서 사용자에게 직접 묻는 3가지 범주(시스템이 스스로 판정하지 않음 — `AskUserQuestion`으로 확인):

| 범주 | 판정 결과 | 후속 동작 |
|------|---------|---------|
| 한 폴더 안에 여러 파라다임 워크스페이스가 있음 (모노레포, 2개 이상 — backend/frontend/desktop/mobile 임의 조합) | `workspace_mode: true` | analyzer가 워크스페이스별 반복 분석(kind 개수·종류 무관) + `api_contracts.json` 로컬 매칭 (Step 0.5/8.5) |
| 파라다임별로 별도 폴더/저장소로 분리됨 (현재 1:1 페어) | 한 번의 harness-init이 두 독립 Lane 생성 → 각 `workspace_mode: false` → 결정적 validator barrier 후 양쪽 `_workspace/pair_config.md` | `refresh-pair-index.mjs`가 backend 계약 추출·consumer 드리프트를 AI 없이 검증. 각 저장소 하네스와 Git 수명주기는 독립 유지 |
| 단일 파라다임 (backend만 / frontend만 / desktop만 / mobile만) | `workspace_mode: false`, 연결 없음 | 기존 로직 그대로 (변경 없음) |

kind는 `docs/paradigm-registry.md`에 등록된 값(backend/frontend/desktop/mobile, 향후 확장 가능) 중 임의 조합·개수(N)로 존재할 수 있다 — 판정 로직 자체는 워크스페이스 배열 길이에 의존하지 않고 "묶여 있는가/분리됐는가/단일인가" 3분류만 유지한다. 휴리스틱 탐지(이 문서의 스택 탐지 시그니처를 하위 디렉토리별로 가볍게 스캔)는 위 질문의 옵션 설명에 힌트로만 덧붙는다 — 최종 분기는 항상 사용자 선택을 따른다. 상세: `skills/harness-init/SKILL.md` Step 2.5/2.6.

---

## 마이그레이션 시나리오 매트릭스

migration-planner가 사전 정의한 변환 시나리오:

| 소스 | 타겟 | 매핑 테이블 템플릿 | 위험도 |
|------|------|---------------|------|
| Struts 1.x | Spring MVC / Spring Boot | Action→Controller, ActionForm→DTO, ActionForward→ViewName, struts-config.xml→`@RequestMapping` | HIGH |
| Struts 2.x | Spring Boot | `@Action`→`@RequestMapping`, interceptor→filter/aspect | MEDIUM |
| iBatis | MyBatis 3 | sqlmap → namespace, parameterClass → parameterType | MEDIUM |
| iBatis / MyBatis | JPA | XML 쿼리 → JPQL/`@Query`/메서드명, ResultMap → Entity | HIGH |
| EJB 2.x | Spring (또는 Spring Boot) | Session Bean → `@Service`, Entity Bean → JPA Entity, MDB → `@KafkaListener`/`@JmsListener` | EXTREME |
| Spring 3~4 (XML) | Spring Boot 3 (어노테이션) | applicationContext.xml → `@Configuration` + `@Bean` | MEDIUM |
| JSP scriptlet | Thymeleaf / React / Vue | `<%...%>` → template syntax, taglib → directive | HIGH |
| Vue 2 (Options API) | Vue 3 (Composition API) | `data/methods/computed` → `<script setup>` + `ref/reactive/computed`, `Vue.extend` → `defineComponent`, filter → method/computed | MEDIUM |
| Vuex | Pinia | `state/mutations/actions` → `defineStore` + state/getters/actions, namespaced modules → 개별 store | MEDIUM |
| Nuxt 2 | Nuxt 3 | `asyncData/fetch` → `useAsyncData/useFetch`, Vuex → Pinia, plugins API 변경, `@nuxtjs/composition-api` 제거 | HIGH |
| Vue CLI (webpack) | Vite | `vue.config.js` → `vite.config.ts`, env 변수 `VUE_APP_*` → `VITE_*`, polyfill 재설정 | LOW~MEDIUM |
| .NET Framework | .NET Core / .NET 8 | `web.config` → `appsettings.json`, `System.Web` → `Microsoft.AspNetCore.*` | HIGH |
| Oracle PL/SQL → Java/Service | DB 로직을 애플리케이션 코드로 | 절차형 → 객체형, 패키지 → 서비스 클래스 | EXTREME |
| Oracle → PostgreSQL | DB 엔진 전환 | 함수/타입/문법 차이, 시퀀스, 힌트, 패키지 | HIGH |
| MySQL → MariaDB | 같은 엔진 변종 | 거의 호환, 일부 함수 차이 | LOW |
| jQuery → Vue/React | 클라이언트 프레임워크 | DOM 조작 → 컴포넌트, AJAX → fetch/axios | HIGH |
| AngularJS (1.x) → Angular (15+) | 동일 이름 다른 프레임워크 | 사실상 전면 재작성 | EXTREME |
| Java 8 → Java 17/21 | 언어 버전 업 | Records, Sealed, Pattern Matching 활용, deprecated 제거 | LOW~MEDIUM |
| Python 2 → Python 3 | 언어 버전 업 | print, unicode, division, 모듈 변경 | MEDIUM |
| Ant → Maven | 빌드 도구 | target → goal, custom task → plugin | MEDIUM |
| Maven → Gradle | 빌드 도구 | pom.xml → build.gradle, plugin 매핑 | MEDIUM |

위험도:
- LOW: 1~2주 PoC, 자동 변환 도구 활용 가능
- MEDIUM: 1~3개월, 모듈 단위 변환, 도구 + 수동
- HIGH: 3~12개월, Phase 분리 + canary 필수
- EXTREME: 6개월+, 사실상 재작성 수준, 비즈니스 동결 위험

---

## 신규 스택/파라다임 추가 방법

**기존 kind(backend/frontend/desktop/mobile — `docs/paradigm-registry.md` 참조)에 속하는 신규 스택 추가** (예: Flutter는 향후 mobile에, WPF는 현재 desktop에 포함):

1. analyzer.md의 Step 1~2 탐지 시그니처 표에 추가
2. 분석 깊이 결정 (HIGH/MEDIUM/LOW)
3. 이 문서의 QA Boundary 세부 표에 boundary_group 매핑 + boundary 4쌍 정의 (신규 boundary_group 불필요, 기존 3계열 중 매핑 우선)
4. 필요 시 migration-planner의 매핑 테이블 템플릿 추가
5. 이 문서 갱신

**완전히 새로운 kind 추가** (예: cli, batch, embedded):

1. `docs/paradigm-registry.md`에 kind 행 추가 (표시명·has_ui·calls_backend_api 기본값·entry_point_concept·boundary_group·layer_role_names 정의)
2. 이 문서에 탐지 시그니처 섹션 신설
3. QA Boundary 원칙 표의 3계열 중 매핑 시도, 안 맞으면 신규 계열 추가(드물어야 함)
4. `agents/pattern-extractor.md`의 "추출 대상 카테고리 세트" 레지스트리에 이 kind용 세트 등록
5. `agents/analyzer.md`/`agents/writer.md`/`agents/qa.md`/`skills/scaffold-feature/SKILL.md` 본문은 원칙적으로 **수정 불필요**(모두 레지스트리를 참조/순회하는 구조) — 수정이 필요하다면 해당 파일이 kind를 하드코딩하고 있다는 신호

특수 레거시 스택은 legacy-decoder를 우선 활용 (구조 분해 + 의도 추정).
