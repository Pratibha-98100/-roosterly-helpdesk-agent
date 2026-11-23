const test = require("node:test");
const assert = require("node:assert");
const { sumUsage, costPer100 } = require("../src/cost");

test("sumUsage adds up all LLM calls for a ticket", () => {
  const u = sumUsage([
    { prompt_tokens: 1800, completion_tokens: 200, total_tokens: 2000 },
    { prompt_tokens: 1800, completion_tokens: 250, total_tokens: 2050 },
  ]);
  assert.deepStrictEqual(u, { input: 3600, output: 450, calls: 2 });
});

test("sumUsage counts hidden thinking tokens (total - prompt)", () => {
  // Real shape seen with gemini-3.5-flash: 1845 + 322 != 2750
  assert.deepStrictEqual(sumUsage([{ prompt_tokens: 1845, completion_tokens: 322, total_tokens: 2750 }]), { input: 1845, output: 905, calls: 1 });
});

test("sumUsage returns null when no LLM call was made (e.g. empty ticket)", () => {
  assert.strictEqual(sumUsage([]), null);
  assert.strictEqual(sumUsage(undefined), null);
  assert.strictEqual(sumUsage([null]), null);
});

test("costPer100 uses the average per ticket", () => {
  const r = costPer100([{ input: 2000, output: 400, calls: 1 }, { input: 2000, output: 400, calls: 1 }], 0.3, 2.5);
  // per ticket: 2000*0.3/1e6 + 400*2.5/1e6 = 0.0006 + 0.001 = 0.0016
  assert.ok(Math.abs(r.perTicketUsd - 0.0016) < 1e-12);
  assert.ok(Math.abs(r.per100Usd - 0.16) < 1e-9);
  assert.strictEqual(costPer100([], 0.3, 2.5), null);
});
