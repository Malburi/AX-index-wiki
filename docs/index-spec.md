# Index Specification

`_workspace/index/` 하위 JSON 파일들의 스키마 정의.

기본 인덱스는 플러그인의 `scripts/build-index.mjs`가 모델 토큰 없이 생성하고, analyzer는 결정할 수 없는 관계만 작은 AI patch로 보강한다. 후속 에이전트(impact-analyzer, sql-reviewer, change-safety, migration-planner 등)는 병합된 최종 인덱스를 조회한다.

초기화 analyzer는 대형 JSON을 직접 읽지 않는다. 인덱서가 함께 만드는 `_workspace/index/_analysis_input.json`에서 coverage·복잡도·index별 count·workspace를 읽고, `scripts/query-index.mjs`의 `summary`·`unresolved --offset N --limit 200`·bounded `search`로 필요한 근거만 조회한다. 200은 전체 제한이 아니라 한 배치 크기이며 `next_offset: null`까지 전부 처리한다.

초기화 검증은 `scripts/validate-harness.mjs`가 모든 index 항목의 schema required/type/enum, graph node 참조, AI edge의 file:line/evidence, 실제 근거 파일, analyzer evidence density, unresolved 보고, 생성 문서 완성도를 전수 검사한다. `_workspace/03_validator_result.json`은 기계 판정, `03_validator_report.md`는 사람이 읽는 결과다.

## 생성 아키텍처

1. `harness-init`이 최초 구성 질문에서 `single-root|monorepo|paired-roots|selected-paths`를 확정하고 `_workspace/indexer-config.json`에 `init_layout`, `include_paths`, workspace 정보를 기록한다. 전체 분석은 `["."]`, 특정 모듈 분석은 검증된 루트 상대경로만 사용한다. `paired-roots`는 양쪽 root에 독립 설정을 기록한 뒤 각각 인덱싱한다.
2. `build-index.mjs`가 파일을 직접 읽어 `_meta.json`·`symbols.json`·`call_graph.json`과 조건부 인덱스를 원자적으로 기록한다.
3. 파일 내용 hash+인덱서 버전+workspace 설정을 `_workspace/.index-cache/`에 저장해 incremental 실행에서 변경되지 않은 파일 결과를 재사용한다.
4. 프로젝트 심볼 후보가 여러 개인 호출/DI는 `_workspace/index/_unresolved.jsonl`에 개수 제한 없이 전부 기록한다. 후보가 없는 외부 라이브러리 호출은 AI 입력으로 보내지 않는다. analyzer는 컨텍스트 관리를 위해 200건 이하 배치로 나누지만 모든 배치를 EOF까지 처리한다.
5. Standard/Full analyzer는 이 파일이 지목한 파일·라인 주변만 읽고 `_ai_patch.json`의 `add_edge` operation을 생성한다. `build-index.mjs --apply-ai-patch`가 node id와 edge type을 검증한 뒤 병합한다.

### 어댑터 커버리지 계약

전역 `_meta.json.adapter_coverage`는 언어 목록이 아니라 **이번 실행에서 실제로 읽힌 파일의 결정적 분석 수준**을 기록한다.

| 상태 | 의미 | analyzer 동작 |
|---|---|---|
| `FULL` | 모든 발견 파일이 정식 결정적 어댑터 범위 | 인덱스를 정본으로 사용 |
| `PARTIAL` | JSP·ASP·XAML·Razor·COBOL·ABAP 등 기본 심볼/진입점/이벤트는 추출했지만 의미 보강이 필요한 텍스트 형식 존재 | PARTIAL 파일과 unresolved 근거만 선택적으로 확인 |
| `WARN` | Oracle Forms·PowerBuilder·리포트 등 읽을 수 없는 전용/바이너리 원본 존재 | 파일 목록을 공개하고 텍스트/XML 내보내기 전에는 분석 완료로 간주하지 않음 |

`extensions[]`는 확장자별 `FULL|PARTIAL`과 파일 수를, `unsupported_files[]`는 미지원 파일의 프로젝트 상대경로를 전부 보존한다. Django/Flask처럼 중첩 route prefix를 결정적으로 합성하지 못하는 프레임워크 신호가 있으면 Python도 보수적으로 `PARTIAL`로 판정한다.

전역 `_meta.json.init_layout`은 사용자가 선택한 프로젝트 배치 형태를, `include_paths`는 실제로 읽은 초기화 범위를 기록한다. 전체 범위는 `["."]`, 선택 범위는 프로젝트 루트 기준 상대경로 배열이다. 구형 config에는 `workspace_mode`와 `include_paths`로부터 호환 값을 채우되, 최초 사용자 범위 문서의 구성을 조용히 바꾸지 않는다.

Lite도 결정적 `symbols.json`·`call_graph.json`·`_meta.json`은 생성한다. Lite에서 생략되는 것은 인덱스 자체가 아니라 AI 의미 보강이다. Node/스크립트 실행이 불가능한 경우에만 analyzer가 기존 직접 생성 방식으로 폴백한다.

---

## 공통 규칙

- 파일 형식: JSON
- 인코딩: UTF-8 (BOM 없음)
- 들여쓰기: 2칸 (압축 안 함, 사람이 검토 가능)
- 용량 한도: 각 파일 종류별 한도 (analyzer.md 참조). 초과 시 분할.

**워크스페이스 태깅 (모노레포/멀티레포):** `_workspace/index/_meta.json`(전역 신선도 파일, `agents/analyzer.md` Phase C 참조)에 `workspace_mode: true`가 기록된 프로젝트에서는, `call_graph.json`/`symbols.json`/`sql_usage.json` 등 배열 항목마다 optional `workspace` 필드(예: `"backend"`, `"frontend"` — `_meta.json.workspaces[].id` 참조)가 추가된다. `workspace_mode`가 없거나 false인 프로젝트(단일 스택)는 이 필드 자체가 등장하지 않으며 기존 소비자(analyze-impact 등)는 무영향이다.

**출처·신뢰도:** 결정적 항목에는 `origin: "deterministic-indexer"`, AI patch 항목에는 `origin: "ai-enrichment"`를 기록한다. 관계 항목은 `confidence: HIGH|MEDIUM|LOW`를 가질 수 있고 AI 항목은 짧은 `evidence`를 함께 기록한다. 소비자는 origin을 모르는 구버전 데이터도 계속 허용한다.

각 인덱스 파일은 최상위에 메타 정보:

```json
{
  "_meta": {
    "generated_at": "2026-06-02T15:30:00Z",
    "generator": "analyzer",
    "version": "1.0",
    "source_root": "/path/to/project",
    "mode": "init|incremental|feature-scoped",
    "node_count": 1234,
    "edge_count": 5678
  },
  "data": [...]
}
```

---

## call_graph.json

호출 관계 그래프. HTTP 호출 외에도 `markup_event`, `ui_event`, `scheduler`, `process_entry` edge로 JSP/ASP.NET/WPF/WinForms 이벤트, 스케줄러, 비웹 실행 진입점을 handler에 연결한다. 결정적 인덱서가 출력하는 모든 edge type은 `call_graph.schema.json` enum과 같은 릴리스에서 함께 갱신해야 한다.

```json
{
  "_meta": {...},
  "nodes": [
    {
      "id": "com.example.OrderService.cancel",
      "type": "method",
      "file": "src/main/java/com/example/OrderService.java",
      "line": 42,
      "visibility": "public",
      "static": false,
      "annotations": ["@Transactional"],
      "signature": "void cancel(Long orderId)"
    }
  ],
  "edges": [
    {
      "from": "com.example.OrderController.cancel",
      "to": "com.example.OrderService.cancel",
      "type": "call",
      "file": "src/main/java/com/example/OrderController.java",
      "line": 56
    }
  ]
}
```

`type` 값:
- `call` — 메서드 직접 호출
- `inject` — DI 주입 관계 (Spring `@Autowired` 등)
- `inherit` — 상속/구현
- `reflect` — 리플렉션 가능성 (heuristic, 신뢰도 낮음)

**위키 렌더링 규칙(참고):** `scripts/build-wiki.mjs`가 pair에서는 먼저 backend → client → backend 증분 refresh와 API drift 검증을 수행한 뒤 `call_graph.json`과 SQL/API/external/schema 인덱스를 `.claude/wiki/call-graph.html`의 전체 그래프로 결합한다. 기본 경로에는 AI 호출이 없다. `call-graph.html`은 위키 sidebar·navigation을 포함하지 않는 독립 그래프 전용 문서이며, 위키 안의 그래프 링크는 이 문서를 새 창으로 열어 현재 문맥을 보존한다. 7종 시각 타입, 노드·엣지 필터, 저장소 필터, 이웃 강조와 허브 표시를 제공하며 상세 패널은 노드의 원본 식별자·file:line·signature·visibility·origin·confidence와 전체 outbound/inbound 이웃, edge type·evidence·file:line을 표시한다. `_workspace/01_analyzer_report.md`의 인덱서 한계는 정확한 심볼 식별자·`Class.method`·파일 경로/파일명이 finding에 명시된 경우에만 해당 노드에 연결한다. 심각도별 복합 문단은 분리하고, 전역 보안 위험·탐지 신뢰도·일반 dead-code 주의는 노드 타입이나 in-degree만으로 연결하지 않는다. 단순 `in-degree=0`은 배지나 경고를 만들지 않는다. dead-code 항목도 `confidence: HIGH`와 별도 `evidence`가 모두 있을 때만 호출 그래프에 표시하고 나머지는 위험 보고서에서만 제공한다. FastAPI endpoint는 `include_router` import 대상과 `APIRouter(prefix=...)`, 정적으로 확정 가능한 설정값·f-string prefix, route path를 합성한다. 두 로컬 API 인덱스를 method/path_pattern으로 매칭해 namespace된 `api_contract` edge를 만들며, 렌더링 성공과 계약 품질 상태를 분리 기록한다. 선택적인 `agents/wiki-builder.md`는 `_workspace/wiki-narrative.json`만 보강하고 HTML/CSS/JavaScript를 작성하지 않는다.

---

## symbols.json

모든 클래스/메서드/함수 심볼 인덱스.

```json
{
  "_meta": {...},
  "symbols": [
    {
      "id": "com.example.OrderService",
      "type": "class",
      "file": "src/main/java/com/example/OrderService.java",
      "line": 10,
      "package": "com.example",
      "extends": "AbstractService",
      "implements": ["OrderOperations"],
      "annotations": ["@Service"],
      "methods": [
        {"name": "cancel", "id": "com.example.OrderService.cancel", "line": 42, "visibility": "public"}
      ]
    }
  ]
}
```

언어별 식별자:
- Java: 완전 자격 이름 (`com.example.X.method`)
- Python: 모듈.클래스.함수 (`services.order.OrderService.cancel`)
- JavaScript/TypeScript: 파일경로::심볼명 (`src/services/order.ts::cancelOrder`)
- Go: 패키지.함수 (`services.CancelOrder`)

---

## sql_usage.json

SQL ID ↔ 호출 위치 매핑.

```json
{
  "_meta": {...},
  "sqls": [
    {
      "id": "ORDER_LMS_S01",
      "file": "WEB-INF/config/query/query-order-ora.xml",
      "line": 23,
      "type": "select",
      "tables": ["TBL_ORDER"],
      "columns_selected": ["ORDER_ID", "USER_ID", "STATUS"],
      "columns_where": ["USER_ID", "STATUS"],
      "text_preview": "SELECT ORDER_ID, USER_ID, STATUS FROM TBL_ORDER WHERE USER_ID = ? AND STATUS = ?"
    }
  ],
  "usages": [
    {
      "sql_id": "ORDER_LMS_S01",
      "file": "src/main/java/com/example/OrderService.java",
      "line": 78,
      "method": "com.example.OrderService.findByUser"
    }
  ]
}
```

`type` 값: `select`, `insert`, `update`, `delete`, `ddl`.

문자열 기반 raw SQL은 같은 따옴표 경계 안에서 완결된 문장만 검사하고 `SELECT … FROM`, `INSERT INTO`, `UPDATE … SET`, `DELETE FROM` 구조를 만족할 때만 수집한다. HTTP method `"DELETE"`, UI event `select-*`, 번역·mock JSON 키, 번들 라이브러리 상수처럼 SQL 키워드로 시작하기만 하는 문자열은 SQL로 기록하지 않는다.

`tables`/`columns_*` 는 best-effort 파싱. 동적 SQL은 누락 가능.

---

## schema.json

DB 스키마 스냅샷.

```json
{
  "_meta": {
    ...,
    "source": "live_db|ddl_files|orm_mapping",
    "dialect": "oracle|postgresql|mysql|..."
  },
  "tables": [
    {
      "name": "TBL_ORDER",
      "schema": "PUBLIC",
      "columns": [
        {
          "name": "ORDER_ID",
          "type": "NUMBER(19)",
          "nullable": false,
          "default": null,
          "primary_key": true
        },
        {
          "name": "STATUS",
          "type": "VARCHAR2(20)",
          "nullable": false,
          "default": "'PENDING'"
        }
      ],
      "primary_key": ["ORDER_ID"],
      "foreign_keys": [
        {
          "name": "FK_ORDER_USER",
          "columns": ["USER_ID"],
          "references_table": "TBL_USER",
          "references_columns": ["USER_ID"]
        }
      ],
      "indexes": [
        {
          "name": "IDX_ORDER_USER_STATUS",
          "columns": ["USER_ID", "STATUS"],
          "unique": false
        }
      ],
      "row_count_estimate": 1234567
    }
  ],
  "relations": [
    {
      "type": "foreign_key",
      "name": "FK_ORDER_USER",
      "from_table": "TBL_ORDER",
      "from_columns": ["USER_ID"],
      "to_table": "TBL_USER",
      "to_columns": ["USER_ID"],
      "file": "db/schema.sql",
      "evidence": "DDL FOREIGN KEY",
      "origin": "deterministic-indexer",
      "confidence": "HIGH"
    },
    {
      "type": "query_join",
      "from_table": "TBL_ORDER",
      "from_columns": ["USER_ID"],
      "to_table": "TBL_USER",
      "to_columns": ["USER_ID"],
      "sql_id": "com.example.OrderMapper.findOrders",
      "file": "src/main/resources/mapper/OrderMapper.xml",
      "line": 42,
      "evidence": "O.USER_ID = U.USER_ID",
      "origin": "deterministic-indexer",
      "confidence": "MEDIUM"
    }
  ],
  "views": [...],
  "procedures": [...],
  "functions": [...],
  "triggers": [...]
}
```

`relations`는 관계도를 위한 정규화된 전체 관계 배열이다. `foreign_key`는 DDL에 선언된 물리 FK이므로 기본 신뢰도 `HIGH`, `query_join`은 MyBatis·annotation·raw SQL의 `alias.column = alias.column` 조건에서 추론한 논리 관계이므로 기본 신뢰도 `MEDIUM`이다. 논리 JOIN을 물리 FK로 표현하지 않는다. 위키는 두 타입을 실선/점선으로 구분하고 모든 `file:line`·SQL 조건 근거를 표에 보존한다.

`source` 값:
- `live_db` — 운영/스테이징 DB read-only 직접 조회
- `ddl_files` — `*.sql`, `V*.sql`, Liquibase changeset 등에서 파싱
- `orm_mapping` — `@Entity` 클래스에서 역추출

`row_count_estimate` 는 live_db 모드일 때만 채워짐.

---

## transactions.json

트랜잭션 경계 식별.

```json
{
  "_meta": {...},
  "boundaries": [
    {
      "id": "tx_001",
      "entry_method": "com.example.OrderService.cancel",
      "file": "src/main/java/com/example/OrderService.java",
      "line": 42,
      "marker": "@Transactional",
      "propagation": "REQUIRED",
      "isolation": "DEFAULT",
      "rollback_for": ["Exception.class"],
      "methods_in_scope": [
        "com.example.OrderService.cancel",
        "com.example.OrderDao.updateStatus",
        "com.example.RefundService.process"
      ],
      "external_io_calls": [
        {"target": "com.example.PaymentGatewayClient.refund", "type": "http"}
      ]
    }
  ]
}
```

`external_io_calls` 는 트랜잭션 경계 안에서의 외부 호출 — 위험 항목.

---

## external_io.json

외부 통신 식별.

```json
{
  "_meta": {...},
  "communications": [
    {
      "id": "ext_001",
      "type": "http",
      "file": "src/main/java/com/example/PaymentClient.java",
      "line": 45,
      "method": "com.example.PaymentClient.charge",
      "target": "https://api.payment.example.com/charge",
      "timeout_ms": 30000,
      "retry_policy": "exponential_backoff(3)",
      "in_transaction": false
    },
    {
      "id": "ext_002",
      "type": "kafka_producer",
      "topic": "orders.events",
      "file": "src/main/java/com/example/OrderEventPublisher.java",
      "line": 12
    },
    {
      "id": "ext_003",
      "type": "file_io",
      "operation": "read",
      "path_pattern": "/data/batch/*.csv",
      "file": "src/main/java/com/example/BatchJob.java",
      "line": 30
    }
  ]
}
```

`type` 값: `http`, `kafka_producer`, `kafka_consumer`, `rabbit_*`, `sqs_*`, `file_io`, `external_db`, `ldap`, `mail`, `redis`, `s3`, etc.

---

## env_branches.json

환경 분기 코드 위치.

```json
{
  "_meta": {...},
  "profiles": ["dev", "stg", "prod"],
  "branches": [
    {
      "file": "src/main/java/com/example/SomeConfig.java",
      "line": 23,
      "type": "annotation",
      "marker": "@Profile(\"prod\")",
      "method": "com.example.SomeConfig.productionOnlyBean"
    },
    {
      "file": "src/main/resources/application.yml",
      "line": null,
      "type": "config_file",
      "marker": "spring.profiles.active",
      "values_per_profile": {
        "dev": "localhost",
        "prod": "prod-db.internal"
      }
    },
    {
      "file": "src/services/feature.ts",
      "line": 12,
      "type": "code_if",
      "marker": "if (process.env.NODE_ENV === 'production')",
      "method": "feature.ts::initialize"
    }
  ]
}
```

---

## dead_code.json

데드 코드 후보 (확정 아님 — 리플렉션 등 동적 호출 가능성).

```json
{
  "_meta": {
    ...,
    "warning": "Static analysis only. Dynamic invocation (reflection, DI by name, external triggers) NOT detected. Verify before removal."
  },
  "unused_methods": [
    {
      "id": "com.example.LegacyService.unusedMethod",
      "file": "src/main/java/com/example/LegacyService.java",
      "line": 88,
      "visibility": "public",
      "reason": "in_degree=0 in call_graph"
    }
  ],
  "unused_sql_ids": [
    {
      "id": "ORDER_LMS_OLD_S01",
      "file": "WEB-INF/config/query/query-order-ora.xml",
      "line": 99,
      "reason": "not referenced in sql_usage"
    }
  ],
  "unused_jsps": [
    {
      "file": "WEB-INF/jsp/back/order/oldList.jsp",
      "reason": "not in any forward path"
    }
  ]
}
```

각 항목에 `reason` 명시. 사용자 검토 후에만 제거.

---

## api_contracts.json

백엔드 라우트 ↔ 프론트엔드 호출 매핑 (모노레포 워크스페이스 간, 또는 cross-repo). `_workspace/index/_meta.json.workspace_mode: true`일 때만 의미 있게 채워진다(생성 조건은 `agents/analyzer.md` Step 8.5 참조).

```json
{
  "_meta": {
    "generated_at": "2026-07-01T09:00:00Z",
    "generator": "analyzer",
    "version": "1.0",
    "source_root": "/path/to/project",
    "mode": "init",
    "node_count": 0,
    "edge_count": 0
  },
  "endpoints": [
    {
      "id": "backend::OrderController.cancel",
      "workspace": "backend",
      "source": "local",
      "method": "POST",
      "path": "/api/orders/{id}/cancel",
      "path_pattern": "^/api/orders/[^/]+/cancel$",
      "handler": "com.example.OrderController.cancel",
      "file": "backend/src/main/java/com/example/OrderController.java",
      "line": 56,
      "request_shape": { "body": ["reason:string"] },
      "response_shape": { "body": ["orderId:number", "status:string"] },
      "auth_required": true
    }
  ],
  "consumers": [
    {
      "id": "frontend::useOrderApi.cancelOrder",
      "workspace": "frontend",
      "source": "local",
      "call_type": "fetch",
      "method": "POST",
      "path_literal": "/api/orders/${id}/cancel",
      "path_pattern": "^/api/orders/[^/]+/cancel$",
      "file": "frontend/src/composables/useOrderApi.ts",
      "line": 22,
      "function": "cancelOrder"
    }
  ],
  "matches": [
    {
      "endpoint_id": "backend::OrderController.cancel",
      "consumer_id": "frontend::useOrderApi.cancelOrder",
      "match_type": "path_pattern",
      "confidence": "HIGH",
      "shape_match": "UNKNOWN",
      "notes": "path_pattern 정규식 일치. shape 비교는 data_flow.json 미연동 시 UNKNOWN"
    }
  ],
  "unmatched_endpoints": ["backend::LegacyController.ping"],
  "unmatched_consumers": ["frontend::useAnalytics.track"]
}
```

필드 설명:
- `workspace`: `_meta.json.workspaces[].id`를 가리킴. 단일 스택(비워크스페이스 모드)이면 `"root"` 고정값.
- `source`: `"local"`(같은 저장소/워크스페이스 내) 또는 `"external"`(연결된 다른 저장소에서 읽어온 것 — cross-repo 케이스에서만 등장).
- `external_repo_path`: `source: "external"`일 때만 존재. `_workspace/pair_config.md`의 `partner_root`를 절대경로로 그대로 기록.
- `confidence`: `HIGH`(path_pattern 정규식 완전 일치 + method 일치) / `MEDIUM`(path만 일치, method 불명 또는 동적 경로 변수명 다름) / `LOW`(문자열 유사도 기반 추정, grep fallback 결과).
- `shape_match`: `MATCH`/`MISMATCH`/`UNKNOWN` — request/response shape 비교 결과. `data_flow.json`과 연동 가능하면 채우고, 아니면 `UNKNOWN`.
- `unmatched_endpoints`/`unmatched_consumers`: `dead_code.json`과 동일한 "확정 아님" 원칙 — 동적 라우트/외부 클라이언트 호출 가능성이 있으므로 자동 삭제 권고 금지.

라우트/호출 시그니처 추출은 `docs/stack-matrix.md`의 QA Boundary 1에 이미 정의된 프레임워크별 짝(예: Spring Boot `@RequestMapping`, Express route path, Vue 3 `$fetch`/`useFetch`)을 그대로 재사용한다 — 신규 추출 패턴을 별도로 정의하지 않는다.

용량 한도: 1MB.

---

## search-index.json (결정적 위키 렌더러 산출물)

`_workspace/index/*.json`과는 별도로, `scripts/build-wiki.mjs`가 `.claude/wiki/search.html`용으로 생성하는 검색 인덱스. 위치는 `.claude/wiki/search-index.json`이며 프로젝트 소스가 아니라 재생성 가능한 위키 산출물이다.

```json
{
  "_meta": {
    "generated_at": "...",
    "generator": "deterministic-wiki",
    "project": "...",
    "page_count": 12,
    "symbol_count": 340,
    "sql_count": 58,
    "graph_node_count": 1500,
    "graph_edge_count": 4200
  },
  "pages": [
    {"id": "overview", "title": "개요", "file": "pages/overview.html", "summary": "...", "keywords": ["..."], "text": "평문 300자 내외"}
  ],
  "symbols": [
    {"id": "com.example.OrderService.cancel", "name": "cancel", "kind": "method", "file": "...", "line": 42, "page": "domains/order.html", "graph_node": "com.example.OrderService.cancel", "signature": "void cancel(Long orderId)"}
  ],
  "sqls": [
    {"id": "ORDER_LMS_S01", "type": "select", "tables": ["TBL_ORDER"], "file": "...", "line": 23, "page": "sql.html"}
  ],
  "index": {
    "terms": {
      "order": ["overview", "com.example.OrderService.cancel", "ORDER_LMS_S01"],
      "cancel": ["com.example.OrderService.cancel"]
    }
  }
}
```

`index.terms`는 역색인(`term → [item id...]`)이며 `pages`/`symbols`/`sqls`의 `id`를 가리킨다. 생성 시점에 각 항목의 제목·키워드·심볼명을 camelCase/snake_case 기준으로 분리한 토큰까지 포함해 채운다(예: `cancelOrder` → `cancel`, `order`, `cancelorder` 모두 색인). `search.html`은 쿼리 시점에 `index.terms`로 후보를 먼저 좁힌 뒤, 후보 집합에만 기존 제목 일치 가중치를 적용한다 — 전체 스캔은 하지 않는다.

검색 결과는 80개로 제한되며, 후보가 80개를 초과하면 "+N개 더 있음 (검색어를 구체화하세요)" 안내가 함께 표시된다(무음 절단 금지).

---

## 인덱스 갱신 정책

| 시나리오 | 동작 |
|---------|------|
| 최초 분석 (init) | 결정적 인덱서가 전체 인덱스 생성 → Standard/Full만 미해결 관계 AI patch |
| incremental | 모든 소스의 hash를 확인하되, 변경 파일만 재파싱하고 나머지는 파일별 캐시 재사용. 이전 AI edge는 안전을 위해 다시 검증·보강 |
| feature-scoped | 사용자 지정 범위만. 인덱스에 부분 추가 (기존 데이터 보존) |

인덱스 stale 감지:
- 각 인덱스의 `_meta.generated_at`과 코드 파일 mtime 비교
- 코드 파일이 더 최신이면 stale 경고

---

## 인덱스가 없거나 stale일 때의 fallback

각 에이전트는 인덱스 우선 조회, 없으면 grep fallback:

| 에이전트 | 인덱스 의존 | Fallback |
|---------|---------|---------|
| impact-analyzer | call_graph, sql_usage, schema | grep 호출 패턴 |
| sql-reviewer | sql_usage, schema | grep SQL ID, DDL 파일 파싱 |
| change-safety | call_graph, external_io | impact-analyzer 결과 활용 |
| migration-planner | call_graph, external_io, transactions, dead_code | analyzer 리포트 마크다운만 활용 |
| qa (Boundary 1, workspace_mode 시) | api_contracts | grep으로 라우트 문자열 ↔ 프론트 호출 문자열 직접 대조 |
| logic-tracer / trace-logic (화면 진입점 시) | api_contracts | grep으로 경로 문자열 직접 대조 |
| scaffold-feature (Phase 3-7, workspace_mode 시) | api_contracts | 없음 — 프론트엔드 생성 단계 스킵 후 "api_contracts.json 없음, analyzer 먼저 실행" 안내 |

Fallback은 느리고 정확도가 떨어진다. 인덱스 정기 갱신을 권장.
