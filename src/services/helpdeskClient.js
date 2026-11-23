// Roosterly Helpdesk API client: rate limiting, retries, error codes.
const axios = require("axios");
const config = require("../config/env");

config.requireEnv(["HELPDESK_BASE_URL", "HELPDESK_API_KEY", "CANDIDATE_EMAIL"]);

const MIN_GAP_MS = 250; // max 4 requests/second; the API allows 5
const MAX_ATTEMPTS = 5; // per request, for 429 / 503 / network errors
const ACTIONS = ["reply", "handoff", "close"];

const http = axios.create({
  baseURL: config.helpdesk.baseUrl,
  timeout: 15000,
  headers: {
    Authorization: `Bearer ${config.helpdesk.apiKey}`,
    "X-Candidate-Email": config.helpdesk.email,
    "Content-Type": "application/json",
  },
});

class HelpdeskError extends Error {
  constructor(status, code, message, problems) {
    super(`${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
    this.problems = problems;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry-After (seconds or HTTP date) -> ms to wait. Default 1s, capped.
const DEFAULT_RETRY_MS = 1000;
const MAX_RETRY_MS = 60000;
function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null || String(value).trim() === "") return DEFAULT_RETRY_MS;
  const text = String(value).trim();
  let ms;
  if (/^\d+(\.\d+)?$/.test(text)) ms = Number(text) * 1000;
  else {
    // Only real HTTP dates (they contain a day/month name); Date.parse("-5") would read a year.
    if (!/[a-z]/i.test(text)) return DEFAULT_RETRY_MS;
    const date = Date.parse(text);
    if (Number.isNaN(date)) return DEFAULT_RETRY_MS;
    ms = date - now;
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_MS);
}

// Rate limiter: each request reserves the next slot MIN_GAP_MS after the last.
let nextSlot = 0;
async function waitForSlot() {
  const now = Date.now();
  const mySlot = Math.max(now, nextSlot);
  nextSlot = mySlot + MIN_GAP_MS;
  if (mySlot > now) await sleep(mySlot - now);
}

let nameSent = false;

// onAttempt (optional) is called after EVERY try, so callers can record retries.
async function request(method, path, body, onAttempt = () => {}) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await waitForSlot();

    const headers = {};
    if (!nameSent && config.helpdesk.name) headers["X-Candidate-Name"] = config.helpdesk.name;

    try {
      const res = await http.request({ method, url: path, data: body, headers });
      nameSent = true;
      await onAttempt({ attempt, ok: true, httpStatus: res.status });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      const data = err.response?.data || {};
      const isLast = attempt === MAX_ATTEMPTS;
      await onAttempt({
        attempt,
        ok: false,
        httpStatus: status || 0,
        errorCode: data.error || (err.response ? "unknown" : "network_error"),
        errorMessage: data.message || err.message,
      });

      if (status === 429 && !isLast) {
        const waitMs = parseRetryAfter(err.response.headers?.["retry-after"]);
        console.error(`[helpdesk] 429 on ${method} ${path}, waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      // 503: nothing saved, safe to retry.
      if (status === 503 && !isLast) {
        const backoff = 500 * 2 ** (attempt - 1); // 0.5s, 1s, 2s, 4s
        console.error(`[helpdesk] 503 on ${method} ${path}, retry ${attempt} in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      // No response: retry GETs; for POSTs let sendDecision decide.
      if (!err.response) {
        if (method === "get" && !isLast) {
          await sleep(500 * attempt);
          continue;
        }
        throw new HelpdeskError(0, "network_error", err.message);
      }

      throw new HelpdeskError(status, data.error || "unknown", data.message || err.message, data.problems);
    }
  }
}

const getStatus = () => request("get", "/status");
const getExamples = () => request("get", "/examples");
const getTicket = (id) => request("get", `/tickets/${encodeURIComponent(id)}`);
const resetPractice = () => request("post", "/practice/reset");

async function listOpenTickets() {
  const all = [];
  let cursor = null;
  do {
    const query = new URLSearchParams({ limit: "10", status: "open" });
    if (cursor) query.set("cursor", cursor);
    const page = await request("get", `/tickets?${query}`);
    all.push(...(page.tickets || []));
    cursor = page.next_cursor || null;
  } while (cursor);
  return all;
}

// A 409 means already handled and is never retried.
async function sendDecision(ticketId, action, body, onAttempt) {
  if (!ACTIONS.includes(action)) throw new Error(`Unknown action: ${action}`);
  const path = `/tickets/${encodeURIComponent(ticketId)}/${action}`;

  try {
    return { result: await request("post", path, body, onAttempt), alreadyHandled: false };
  } catch (err) {
    if (err.code === "already_handled") return { result: null, alreadyHandled: true };

    // Timeout: check the ticket before resending so we never answer twice.
    if (err.code === "network_error") {
      if (await isHandled(ticketId)) return { result: null, alreadyHandled: true };
      try {
        return { result: await request("post", path, body, onAttempt), alreadyHandled: false };
      } catch (retryErr) {
        if (retryErr.code === "already_handled") return { result: null, alreadyHandled: true };
        throw retryErr;
      }
    }
    throw err;
  }
}

// "handled" is null while open and an object once a decision is saved.
async function isHandled(ticketId) {
  const ticket = await getTicket(ticketId);
  return ticket.handled !== null && ticket.handled !== undefined;
}

module.exports = {
  HelpdeskError,
  getStatus,
  getExamples,
  getTicket,
  listOpenTickets,
  sendDecision,
  resetPractice,
  isHandled,
  parseRetryAfter,
  http, // for tests
};
