import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../build-index.mjs";
import { refreshPair } from "../refresh-pair-index.mjs";
import { buildWiki } from "../build-wiki.mjs";

function write(root, rel, content) {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function schemaOf(root) {
  return JSON.parse(readFileSync(join(root, "_workspace", "index", "schema.json"), "utf8"));
}

function find(relations, from, to) {
  return relations.find((item) => item.from_table === from && item.to_table === to);
}

const DDL = `CREATE TABLE users (
  id BIGINT NOT NULL PRIMARY KEY,
  email VARCHAR(200) NOT NULL UNIQUE
);
CREATE TABLE user_profile (
  user_id BIGINT NOT NULL,
  bio VARCHAR(500),
  CONSTRAINT pk_profile PRIMARY KEY (user_id),
  CONSTRAINT fk_profile_user FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE user_setting (
  id BIGINT NOT NULL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  CONSTRAINT uq_setting_user UNIQUE (user_id),
  CONSTRAINT fk_setting_user FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE orders (
  id BIGINT NOT NULL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  CONSTRAINT fk_order_user FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE products (id BIGINT NOT NULL PRIMARY KEY, sku VARCHAR(50) NOT NULL);
CREATE TABLE order_item (
  order_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  PRIMARY KEY (order_id, product_id),
  CONSTRAINT fk_oi_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_oi_product FOREIGN KEY (product_id) REFERENCES products(id)
);
`;

function pairConfigText(fields, partners) {
  const table = partners
    ? `\n## 파트너 목록\n\n| id | type | root | api_contract | stack |\n|---|---|---|---|---|\n${partners.map((item) => `| ${item.id} | ${item.type} | ${item.root} | ${join(item.root, "_workspace", "index", "api_contracts.json")} | ${item.stack} |`).join("\n")}\n`
    : "";
  return `# Pair Configuration\n\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n")}\n${table}`;
}

export async function test(register, assert) {
  register("DDL 유일 제약으로 1:1과 N:1을 가르고 조인 테이블에서 N:M을 파생한다", () => {
    const root = mkdtempSync(join(tmpdir(), "ax-card-"));
    try {
      write(root, "db/schema.sql", DDL);
      buildIndex({ root, mode: "init", tier: "Standard", config: null, quiet: true });
      const schema = schemaOf(root);

      assert.equal(find(schema.relations, "user_profile", "users").cardinality, "one_to_one", "자식 PK == FK 컬럼이면 1:1");
      assert.equal(find(schema.relations, "user_setting", "users").cardinality, "one_to_one", "자식 UNIQUE 제약이면 1:1");
      assert.equal(find(schema.relations, "orders", "users").cardinality, "many_to_one", "유일 제약 없으면 N:1");
      assert.ok(find(schema.relations, "user_profile", "users").cardinality_basis.includes("primary_key"), "1:1 판정 근거 기록");

      const derived = schema.derived_relations;
      assert.equal(derived.length, 1, `조인 테이블 1건: ${JSON.stringify(derived)}`);
      assert.equal(derived[0].cardinality, "many_to_many", "조인 테이블 경유는 N:M");
      assert.equal(derived[0].via_table, "order_item", "경유 테이블 기록");
      assert.ok(schema.tables.find((item) => item.name === "order_item").join_table, "join_table 플래그");
      assert.ok(schema.tables.find((item) => item.name === "users").columns.find((item) => item.name === "email").unique, "컬럼 레벨 UNIQUE 보존");
      assert.equal(schema.tables.find((item) => item.name === "user_setting").unique_constraints.length, 1, "테이블 레벨 UNIQUE 보존");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  register("ORM 매핑 애노테이션에서 DDL 없이도 카디널리티를 확정한다", () => {
    const root = mkdtempSync(join(tmpdir(), "ax-orm-"));
    try {
      write(root, "src/User.java", `@Entity
@Table(name = "users")
public class User {
  @OneToMany(mappedBy = "user")
  private List<Order> orders;
  @OneToOne
  @JoinColumn(name = "profile_id")
  private Profile profile;
  @ManyToMany
  private Set<Role> roles;
}
`);
      write(root, "src/models.py", `class Customer(Base):
    __tablename__ = "customers"
    tags = relationship("Tag", secondary=customer_tag)
    orders = relationship("SalesOrder")

class SalesOrder(Base):
    __tablename__ = "sales_orders"
    customer_id = Column(Integer, ForeignKey("customers.id"))

class Passport(Base):
    __tablename__ = "passports"
    person_id = Column(Integer, ForeignKey("persons.id"), unique=True)
`);
      write(root, "src/article.py", `class Article(models.Model):
    author = models.ForeignKey(Author, on_delete=models.CASCADE)
    seo = models.OneToOneField(SeoMeta, on_delete=models.CASCADE)
    class Meta:
        db_table = "articles"
`);
      write(root, "src/invoice.ts", `@Entity("invoices")
export class Invoice {
  @ManyToOne(() => Customer)
  customer: Customer;
}
`);
      buildIndex({ root, mode: "init", tier: "Standard", config: null, quiet: true });
      const schema = schemaOf(root);
      assert.equal(schema.tables.length, 0, "DDL 테이블이 없어도 schema.json을 만든다");
      assert.ok(schema.entities.length >= 6, `엔티티 매핑 수집: ${schema.entities.length}`);
      assert.equal(schema.entities.find((item) => item.name === "User").table, "users", "@Table(name=) 해석");

      const orm = schema.relations.filter((item) => item.type === "orm_relation");
      assert.equal(find(orm, "users", "Order").cardinality, "one_to_many", "@OneToMany는 1:N");
      assert.equal(find(orm, "users", "Order").owning_side, false, "mappedBy는 소유 측이 아님");
      assert.equal(find(orm, "users", "Profile").cardinality, "one_to_one", "@OneToOne은 1:1");
      assert.equal(find(orm, "users", "Role").cardinality, "many_to_many", "@ManyToMany는 N:M");
      assert.equal(find(orm, "articles", "Author").cardinality, "many_to_one", "models.ForeignKey는 N:1");
      assert.equal(find(orm, "articles", "SeoMeta").cardinality, "one_to_one", "OneToOneField는 1:1");
      assert.equal(find(orm, "customers", "Tag").cardinality, "many_to_many", "secondary=는 N:M");
      assert.equal(find(orm, "sales_orders", "customers").cardinality, "many_to_one", "ForeignKey는 N:1");
      assert.equal(find(orm, "passports", "persons").cardinality, "one_to_one", "unique=True ForeignKey는 1:1");
      // 근거가 없는 관계를 임의로 단정하지 않는다.
      const ambiguous = find(orm, "customers", "sales_orders");
      assert.equal(ambiguous.cardinality, "unknown", "방향이 불확정한 relationship()은 미확정");
      assert.equal(ambiguous.confidence, "LOW", "미확정 관계는 낮은 신뢰도");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  register("위키 데이터 모델이 다중성과 ORM 관계를 근거와 함께 렌더링한다", () => {
    const root = mkdtempSync(join(tmpdir(), "ax-card-wiki-"));
    try {
      write(root, "db/schema.sql", DDL);
      write(root, "_workspace/00_init_scope.md", "# 초기화 분석 범위\n\n테스트용 결정적 범위 기록입니다.\n");
      buildIndex({ root, mode: "init", tier: "Standard", config: null, quiet: true });
      buildWiki({ root });
      const html = readFileSync(join(root, ".claude", "wiki", "pages", "data-model.html"), "utf8");
      assert.ok(html.includes("<th>다중성</th>"), "관계 표에 다중성 열");
      assert.ok(html.includes("<th>다중성 판정 근거</th>"), "관계 표에 판정 근거 열");
      assert.ok(html.includes("N:M 관계 (조인 테이블 경유)"), "N:M 파생 섹션");
      assert.ok(html.includes('id="db-orm"'), "ORM 관계 필터 토글");
      assert.ok(html.includes(">1:1</span>"), "1:1 배지 렌더링");
      assert.ok(html.includes(">N:1</span>"), "N:1 배지 렌더링");
      const graph = readFileSync(join(root, ".claude", "wiki", "call-graph.html"), "utf8");
      assert.ok(graph.includes("DDL FK 1:1"), "호출 그래프 엣지 라벨에 다중성");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  register("백엔드 1개에 클라이언트 N개를 연결하고 클라이언트별 계약 차이를 분리 보고한다", () => {
    const backend = mkdtempSync(join(tmpdir(), "ax-be-"));
    const web = mkdtempSync(join(tmpdir(), "ax-web-"));
    const mobile = mkdtempSync(join(tmpdir(), "ax-mob-"));
    try {
      write(backend, "src/OrderController.java", `@RequestMapping("/orders")
public class OrderController {
  @PostMapping("/{id}/cancel")
  public void cancel() {}
}
`);
      write(web, "src/api.ts", "export const cancel = (id) => fetch(`/orders/${id}/cancel`, { method: 'POST' });\n");
      // 모바일은 백엔드에 없는 endpoint를 호출한다 — 1:N에서 클라이언트별로 잡혀야 한다.
      write(mobile, "src/api.ts", `export const cancel = (id) => fetch(\`/orders/\${id}/cancel\`, { method: 'POST' });
export const status = (id) => fetch(\`/orders/\${id}/status\`, { method: 'GET' });
`);
      for (const [root, id, kind] of [[backend, "backend", "backend"], [web, "frontend", "frontend"], [mobile, "mobile", "mobile"]]) {
        write(root, "_workspace/indexer-config.json", JSON.stringify({
          init_layout: "single-root", include_paths: ["."], workspace_mode: false,
          workspaces: [{ id, path: "", kind, stack: "test", calls_backend_api: kind !== "backend" }],
        }));
      }
      write(backend, "_workspace/pair_config.md", pairConfigText(
        { project_type: "backend", system_wiki_owner: "backend", system_wiki_root: join(backend, ".claude", "wiki") },
        [{ id: "frontend", type: "frontend", root: web, stack: "TypeScript" }, { id: "mobile", type: "mobile", root: mobile, stack: "Android" }],
      ));
      for (const [root, type] of [[web, "frontend"], [mobile, "mobile"]]) {
        write(root, "_workspace/pair_config.md", pairConfigText({
          project_type: type, partner_type: "backend", partner_root: backend,
          partner_api_contract: join(backend, "_workspace", "index", "api_contracts.json"),
          system_wiki_owner: "backend", system_wiki_root: join(backend, ".claude", "wiki"),
        }));
      }
      for (const root of [backend, web, mobile]) {
        buildIndex({ root, mode: "init", tier: "Standard", config: join(root, "_workspace", "indexer-config.json"), quiet: true });
      }

      const result = refreshPair({ backend, consumers: [web, mobile] });
      assert.equal(result.topology, "one-to-many", "1:N 토폴로지 판정");
      assert.equal(result.clients.length, 2, "클라이언트 2개 결과");
      assert.equal(result.clients.find((item) => item.id === "frontend").status, "PASS", "웹은 전부 매칭");
      const mob = result.clients.find((item) => item.id === "mobile");
      assert.equal(mob.status, "WARN", "모바일은 미매칭 존재");
      assert.equal(mob.unmatched_consumers.length, 1, `모바일 미매칭 1건: ${JSON.stringify(mob.unmatched_consumers)}`);
      assert.equal(result.status, "WARN", "한 클라이언트만 WARN이어도 종합 WARN");
      assert.ok(readFileSync(join(backend, "_workspace", "api_drift_summary.md"), "utf8").includes("| mobile |"), "backend 요약에 클라이언트별 행");

      buildWiki({ backend, frontends: [web, mobile] });
      for (const id of ["backend", "frontend", "mobile"]) {
        assert.ok(readFileSync(join(backend, ".claude", "wiki", "pages", "repositories", `${id}.html`), "utf8").length > 0, `${id} 저장소 페이지`);
      }
      const report = readFileSync(join(backend, "_workspace", "08_system_wiki_report.md"), "utf8");
      assert.ok(report.includes("backend, frontend, mobile"), "보고서에 3개 프로젝트");
      assert.ok(report.includes("consumer_wiki_written: false"), "클라이언트 위키는 만들지 않음");
    } finally {
      for (const root of [backend, web, mobile]) rmSync(root, { recursive: true, force: true });
    }
  });

  register("단수 partner 필드만 있는 1:1 설정도 그대로 동작한다", () => {
    const backend = mkdtempSync(join(tmpdir(), "ax-be1-"));
    const web = mkdtempSync(join(tmpdir(), "ax-web1-"));
    try {
      write(backend, "src/OrderController.java", `@RequestMapping("/orders")
public class OrderController {
  @PostMapping("/{id}/cancel")
  public void cancel() {}
}
`);
      write(web, "src/api.ts", "export const cancel = (id) => fetch(`/orders/${id}/cancel`, { method: 'POST' });\n");
      for (const [root, id, kind] of [[backend, "backend", "backend"], [web, "frontend", "frontend"]]) {
        write(root, "_workspace/indexer-config.json", JSON.stringify({
          init_layout: "single-root", include_paths: ["."], workspace_mode: false,
          workspaces: [{ id, path: "", kind, stack: "test", calls_backend_api: kind !== "backend" }],
        }));
      }
      write(backend, "_workspace/pair_config.md", pairConfigText({
        project_type: "backend", partner_type: "frontend", partner_root: web,
        partner_api_contract: join(web, "_workspace", "index", "api_contracts.json"),
      }));
      write(web, "_workspace/pair_config.md", pairConfigText({
        project_type: "frontend", partner_type: "backend", partner_root: backend,
        partner_api_contract: join(backend, "_workspace", "index", "api_contracts.json"),
      }));
      for (const root of [backend, web]) {
        buildIndex({ root, mode: "init", tier: "Standard", config: join(root, "_workspace", "indexer-config.json"), quiet: true });
      }
      const result = refreshPair({ backend, consumer: web });
      assert.equal(result.topology, "one-to-one", "단수 필드는 1:1");
      assert.equal(result.status, "PASS", "전부 매칭");
      assert.equal(result.clients.length, 1, "클라이언트 1개");
      assert.ok(Number.isInteger(result.matched), "1:1 하위 호환 필드 유지");
    } finally {
      for (const root of [backend, web]) rmSync(root, { recursive: true, force: true });
    }
  });
}
