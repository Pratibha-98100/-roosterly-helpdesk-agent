// Retry, Retry-After and timeout tests with a fake axios adapter.
process.env.HELPDESK_BASE_URL = "http://helpdesk.test";
process.env.HELPDESK_API_KEY = "test-key";
process.env.CANDIDATE_EMAIL = "test@example.com";

const test = require("node:test");
const assert = require("node:assert");
const axios = require("axios");
const helpdesk = require("../src/services/helpdeskClient");

// Each step is { status, data, headers } or { timeout: true }.
function script(steps) {
  const calls = [];
  helpdesk.http.defaults.adapter = async (config) => {
    calls.push(`${config.method.toUpperCase()} ${config.url}`);
    const step = steps.shift();
    if (!step) throw new Error(`unexpected extra call: ${config.method} ${config.url}`);
    if (step.timeout) throw new axios.AxiosError("timeout of 15000ms exceeded", "ECONNABORTED", config);
    const response = { status: step.status, data: step.data || {}, headers: step.headers || {}, config, statusText: "" };
    if (step.status >= 400) throw new axios.AxiosError(`Request failed with status code ${step.status}`, "ERR_BAD_RESPONSE", config, null, response);
    return response;
  };
  return calls;
}

const BODY = { language: "nl", category: "question", priority: "P4", reason: "FAQ F02", draft_reply: "Hoi" };
const CONFLICT = { status: 409, data: { error: "already_handled", message: "already handled" } };

test("timeout, ticket still open, retry gets 409 -> treated as already handled", async () => {
  const calls = script([{ timeout: true }, { status: 200, data: { id: "T005", handled: null } }, CONFLICT]);
  const res = await helpdesk.sendDecision("T005", "reply", BODY);
  assert.deepStrictEqual(res, { result: null, alreadyHandled: true });
  assert.deepStrictEqual(calls, ["POST /tickets/T005/reply", "GET /tickets/T005", "POST /tickets/T005/reply"]);
});

test("timeout, GET shows the ticket was handled -> no second POST", async () => {
  const calls = script([{ timeout: true }, { status: 200, data: { id: "T005", handled: { at: "2026-11-21T14:23:27Z", action: "reply" } } }]);
  const res = await helpdesk.sendDecision("T005", "reply", BODY);
  assert.strictEqual(res.alreadyHandled, true);
  assert.strictEqual(calls.filter((c) => c.startsWith("POST")).length, 1);
});

test("timeout, ticket still open, retry succeeds -> sent once", async () => {
  script([{ timeout: true }, { status: 200, data: { id: "T005", handled: null } }, { status: 200, data: { ok: true } }]);
  const res = await helpdesk.sendDecision("T005", "reply", BODY);
  assert.deepStrictEqual(res, { result: { ok: true }, alreadyHandled: false });
});

test("409 on the first POST is never retried", async () => {
  const calls = script([CONFLICT]);
  const res = await helpdesk.sendDecision("T005", "reply", BODY);
  assert.strictEqual(res.alreadyHandled, true);
  assert.strictEqual(calls.length, 1);
});

test("timeout, retry gets 422 -> still an error (not hidden as handled)", async () => {
  script([{ timeout: true }, { status: 200, data: { handled: null } }, { status: 422, data: { error: "validation_failed", problems: ["reason"] } }]);
  await assert.rejects(helpdesk.sendDecision("T005", "reply", BODY), (err) => err.status === 422 && err.code === "validation_failed");
});

test("isHandled reads the verified 'handled' field", async () => {
  script([{ status: 200, data: { id: "T001", handled: null } }]);
  assert.strictEqual(await helpdesk.isHandled("T001"), false);
  script([{ status: 200, data: { id: "T015", handled: { at: "2026-11-21T14:23:27Z", action: "reply" } } }]);
  assert.strictEqual(await helpdesk.isHandled("T015"), true);
});

test("429 waits Retry-After, then retries", async () => {
  const calls = script([{ status: 429, data: { error: "rate_limited" }, headers: { "retry-after": "0" } }, { status: 200, data: { mode: "practice" } }]);
  assert.deepStrictEqual(await helpdesk.getStatus(), { mode: "practice" });
  assert.strictEqual(calls.length, 2);
});

test("401 is not retried", async () => {
  const calls = script([{ status: 401, data: { error: "unauthorized" } }]);
  await assert.rejects(helpdesk.getStatus(), (err) => err.status === 401);
  assert.strictEqual(calls.length, 1);
});

test("parseRetryAfter: numeric seconds", () => {
  assert.strictEqual(helpdesk.parseRetryAfter("2"), 2000);
  assert.strictEqual(helpdesk.parseRetryAfter("0"), 0);
  assert.strictEqual(helpdesk.parseRetryAfter("1.5"), 1500);
  assert.strictEqual(helpdesk.parseRetryAfter(3), 3000);
});

test("parseRetryAfter: HTTP date", () => {
  const now = Date.parse("Sun, 22 Nov 2026 10:00:00 GMT");
  assert.strictEqual(helpdesk.parseRetryAfter("Sun, 22 Nov 2026 10:00:05 GMT", now), 5000);
  assert.strictEqual(helpdesk.parseRetryAfter("Sun, 22 Nov 2026 09:59:00 GMT", now), 0); // past -> now
});

test("parseRetryAfter: missing, garbage and huge values", () => {
  assert.strictEqual(helpdesk.parseRetryAfter(undefined), 1000);
  assert.strictEqual(helpdesk.parseRetryAfter(""), 1000);
  assert.strictEqual(helpdesk.parseRetryAfter("soon"), 1000);
  assert.strictEqual(helpdesk.parseRetryAfter("-5"), 1000);
  assert.strictEqual(helpdesk.parseRetryAfter("99999"), 60000);
});
