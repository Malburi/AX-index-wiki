import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAiPatch, buildIndex } from "../build-index.mjs";

function write(root, rel, content) {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function json(root, name) {
  return JSON.parse(readFileSync(join(root, "_workspace", "index", name), "utf8"));
}

export async function test(register, assert) {
  register("deterministic indexer가 심볼·호출·API·SQL 인덱스를 생성한다", () => {
    const root = mkdtempSync(join(tmpdir(), "ax-indexer-"));
    try {
      write(root, "_workspace/indexer-config.json", JSON.stringify({
        init_layout: "monorepo",
        workspace_mode: true,
        workspaces: [
          { id: "backend", path: "backend", kind: "backend", stack: "Spring Boot" },
          { id: "frontend", path: "frontend", kind: "frontend", stack: "TypeScript", calls_backend_api: true },
        ],
      }));
      write(root, "backend/OrderController.java", `package com.acme;
@RequestMapping("/orders")
public class OrderController {
  @Autowired private OrderService service;
  @PostMapping("/{id}/cancel")
  public void cancel() { service.cancel(); }
}
class OrderService {
  @Transactional
  public void cancel() { repository.remove(); }
}
class Repository { public void remove() {} }
`);
      write(root, "backend/OrderMapper.xml", `<mapper namespace="OrderMapper">
  <update id="cancel">UPDATE ORDERS SET STATUS='CANCEL' WHERE ID=#{id}</update>
</mapper>`);
      write(root, "frontend/api.ts", `export async function cancelOrder(id: string) {
  return fetch(\`/orders/\${id}/cancel\`, { method: "POST" });
}`);

      const first = buildIndex({ root, mode: "init", tier: "Standard", config: null });
      assert.ok(first.indexes.includes("symbols"), "symbols index");
      assert.ok(first.indexes.includes("api_contracts"), "api contracts index");
      assert.ok(first.indexes.includes("sql_usage"), "sql usage index");
      assert.ok(json(root, "symbols.json").symbols.some((item) => item.id === "com.acme.OrderController"), "OrderController symbol");
      const callGraph = json(root, "call_graph.json");
      assert.ok(callGraph.edges.some((item) => item.type === "call" && item.to.endsWith("OrderService.cancel")), `service.cancel call edge: ${JSON.stringify(callGraph)}`);
      assert.equal(json(root, "api_contracts.json").matches.length, 1);
      assert.equal(json(root, "sql_usage.json").sqls[0].id, "OrderMapper.cancel");
      assert.equal(json(root, "_meta.json").init_layout, "monorepo");

      const second = buildIndex({ root, mode: "incremental", tier: "Standard", config: null });
      assert.equal(second.analyzed, 0);
      assert.equal(second.reused, second.files);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  register("Lite도 AI 없이 기본 기계 인덱스를 생성한다", () => {
    const root = mkdtempSync(join(tmpdir(), "ax-indexer-lite-"));
    try {
      write(root, "src/simple.ts", "export function hello() { return 'hello'; }\n");
      const result = buildIndex({ root, mode: "init", tier: "Lite", config: null });
      assert.ok(result.indexes.includes("symbols"));
      assert.ok(result.indexes.includes("call_graph"));
      assert.equal(json(root, "_meta.json").tier, "Lite");
      assert.equal(json(root, "_meta.json").init_layout, "single-root");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  register("Init Scope Gate의 include_paths 밖 소스는 읽지 않는다", () => {
    const root = mkdtempSync(join(tmpdir(), "ax-indexer-scope-"));
    try {
      write(root, "_workspace/indexer-config.json", JSON.stringify({
        init_layout: "selected-paths",
        include_paths: ["selected"],
        workspace_mode: false,
        workspaces: [{ id: "root", path: "", kind: "backend", stack: "unknown" }],
      }));
      write(root, "selected/Included.ts", "export function included() { return 1; }\n");
      write(root, "outside/Excluded.ts", "export function excluded() { return 2; }\n");
      const result = buildIndex({ root, mode: "init", tier: "Standard", config: null });
      const symbols = json(root, "symbols.json").symbols;
      assert.equal(result.files, 1);
      assert.equal(json(root, "_meta.json").init_layout, "selected-paths");
      assert.ok(symbols.some((item) => item.file === "selected/Included.ts"));
      assert.ok(!symbols.some((item) => item.file === "outside/Excluded.ts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  register("raw SQL은 완결된 SQL 문장만 추출하고 UI·HTTP·번역 문자열을 제외한다", () => {
    const root = mkdtempSync(join(tmpdir(), "ax-indexer-raw-sql-"));
    try {
      write(root, "src/WebConfig.java", `registry.allowedMethods("GET", "POST", "DELETE");\n`);
      write(root, "src/ui.js", `
const css = "select-router-transition";
const action = "delete-node";
const query = "SELECT ID, STATUS FROM ORDERS WHERE ID = ?";
const mutation = 'UPDATE ORDERS SET STATUS = ? WHERE ID = ?';
`);
      write(root, "src/mock.json", JSON.stringify({ select: "select-one", delete: "Delete", update: "update:" }));
      write(root, "src/data.sql", "INSERT INTO LABELS VALUES ('Delete', 'Select');\n");
      buildIndex({ root, mode: "init", tier: "Standard", config: null });
      const sqls = json(root, "sql_usage.json").sqls;
      assert.equal(sqls.map((item) => item.type).sort().join(","), "select,update");
      assert.ok(sqls.some((item) => item.tables.includes("ORDERS")));
      assert.ok(sqls.every((item) => ["select", "insert", "update", "delete", "ddl"].includes(item.type)));
      assert.ok(!sqls.some((item) => /WebConfig|mock\.json|data\.sql/.test(item.file)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  register("AI 보강은 전체 JSON 재작성 없이 작은 edge patch만 병합한다", () => {
    const root = mkdtempSync(join(tmpdir(), "ax-indexer-patch-"));
    try {
      write(root, "src/simple.ts", "export function first() { return 1; }\nexport function second() { return 2; }\n");
      buildIndex({ root, mode: "init", tier: "Standard", config: null });
      write(root, "_workspace/index/_ai_patch.json", JSON.stringify({
        version: 1,
        operations: [{ op: "add_edge", edge: { from: "src.simple.first", to: "src.simple.second", type: "call", confidence: "MEDIUM", evidence: "dynamic dispatch resolved from cited snippet" } }],
      }));
      const result = applyAiPatch(root, "_workspace/index/_ai_patch.json");
      assert.equal(result.applied, 1);
      assert.ok(json(root, "call_graph.json").edges.some((item) => item.origin === "ai-enrichment"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  register("미해결 관계가 200건을 넘어도 잘라내지 않고 전부 기록한다", () => {
    const root = mkdtempSync(join(tmpdir(), "ax-indexer-unresolved-"));
    try {
      const calls = Array.from({ length: 250 }, (_, i) => `  target.run(${i});`).join("\n");
      write(root, "src/ambiguous.ts", `class First {\n  run(value: number) {}\n}\nclass Second {\n  run(value: number) {}\n}\nexport function caller(target: unknown) {\n${calls}\n}\n`);
      buildIndex({ root, mode: "init", tier: "Standard", config: null });
      const lines = readFileSync(join(root, "_workspace", "index", "_unresolved.jsonl"), "utf8").trim().split(/\r?\n/);
      assert.equal(lines.length, 250);
      assert.equal(json(root, "_meta.json").unresolved_count, 250);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  register("DDL FK·인덱스와 MyBatis JOIN 관계·mapper 사용처를 결정적으로 전수 추출한다", () => {
    const root = mkdtempSync(join(tmpdir(), "ax-indexer-db-relations-"));
    try {
      write(root, "src/main/java/com/acme/OrderMapper.java", `package com.acme;
public interface OrderMapper {
  void findOrders();
  void findTenantOrders();
}
`);
      write(root, "src/main/resources/mapper/OrderMapper.xml", `<mapper namespace="com.acme.OrderMapper">
  <select id="findOrders">
    SELECT O.ORDER_ID, U.USER_NAME
      FROM TBL_ORDER O
      JOIN TBL_USER U ON O.USER_ID = U.USER_ID
  </select>
  <select id="findTenantOrders">
    SELECT O.ORDER_ID
      FROM TBL_ORDER O, TBL_TENANT T
     WHERE O.TENANT_ID = T.TENANT_ID
  </select>
</mapper>`);
      write(root, "src/main/resources/schema.sql", `CREATE TABLE TBL_USER (
  USER_ID VARCHAR(20) PRIMARY KEY,
  USER_NAME VARCHAR(100)
);
CREATE TABLE TBL_TENANT (
  TENANT_ID VARCHAR(20) PRIMARY KEY
);
CREATE TABLE TBL_ORDER (
  ORDER_ID VARCHAR(20) PRIMARY KEY,
  USER_ID VARCHAR(20),
  TENANT_ID VARCHAR(20),
  CONSTRAINT FK_ORDER_USER FOREIGN KEY (USER_ID) REFERENCES TBL_USER (USER_ID)
);
CREATE UNIQUE INDEX IF NOT EXISTS IDX_ORDER_USER ON TBL_ORDER (USER_ID);
`);

      buildIndex({ root, mode: "init", tier: "Full", config: null });
      const schema = json(root, "schema.json");
      const sqlUsage = json(root, "sql_usage.json");
      const order = schema.tables.find((table) => table.name === "TBL_ORDER");
      assert.ok(order.foreign_keys.some((fk) => fk.name === "FK_ORDER_USER" && fk.references_table === "TBL_USER"), JSON.stringify(order));
      assert.ok(order.indexes.some((index) => index.name === "IDX_ORDER_USER" && index.unique === true), JSON.stringify(order));
      assert.ok(schema.relations.some((relation) => relation.type === "foreign_key" && relation.from_table === "TBL_ORDER" && relation.to_table === "TBL_USER"), JSON.stringify(schema.relations));
      assert.ok(schema.relations.some((relation) => relation.type === "query_join" && relation.from_table === "TBL_ORDER" && relation.to_table === "TBL_USER"), JSON.stringify(schema.relations));
      assert.ok(schema.relations.some((relation) => relation.type === "query_join" && [relation.from_table, relation.to_table].includes("TBL_TENANT")), JSON.stringify(schema.relations));
      assert.ok(sqlUsage.usages.some((usage) => usage.method === "com.acme.OrderMapper.findOrders" && usage.confidence === "HIGH"), JSON.stringify(sqlUsage.usages));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
