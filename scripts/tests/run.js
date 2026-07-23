// 최소 테스트 러너 (무의존). 실행: node scripts/tests/run.js
import { test as registerIndexerTests } from "./build-index.test.mjs";
import { test as registerValidatorTests } from "./validate-harness.test.mjs";

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const assert = {
  equal(a, b, msg) {
    if (a !== b) throw new Error(`${msg || "equal"} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  },
  ok(v, msg) {
    if (!v) throw new Error(`${msg || "expected truthy"} — got ${JSON.stringify(v)}`);
  },
};

await registerIndexerTests(test, assert);
await registerValidatorTests(test, assert);

let passed = 0,
  failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed++;
    console.log("  ✓ " + t.name);
  } catch (e) {
    failed++;
    console.error("  ✗ " + t.name + "\n    " + e.message);
  }
}
console.log(`\n${passed} passed, ${failed} failed (${tests.length} total)`);
process.exit(failed ? 1 : 0);
