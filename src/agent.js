// npm start: posts one decision per open ticket.
// Safe to re-run: handled tickets are not fetched, 409 is never retried, LLM failures leave the ticket open.
const helpdesk = require("./services/helpdeskClient");
const { decideTicket } = require("./services/decisionService");
const { logTicket, LOG_FILE } = require("./services/logger");
const db = require("./services/dbService");
const { sumUsage } = require("./cost");

async function processTicket(ticket, runId) {
  const started = Date.now();
  const base = { run: runId, ticket: ticket.id };
  const ticketUuid = await db.upsertTicket(ticket);

  let decision;
  try {
    decision = await decideTicket(ticket);
  } catch (err) {
    logTicket({ ...base, status: "error", stage: "decide", http: err.status, error: String(err.message).slice(0, 200) });
    await db.recordAttempt({ ticketUuid, runId, endpoint: "llm", attempt: 1, ok: false, httpStatus: err.status, errorCode: "llm_error", errorMessage: err.message });
    if (err.status === 429 || err.status === 401) throw new Error(`LLM quota/auth problem (${err.status}); stopping. Re-run later.`);
    return "error";
  }

  const { action, payload, overrides } = decision;
  const summary = {
    ...base,
    action,
    language: payload.language,
    category: payload.category,
    priority: payload.priority,
    confidence: payload.confidence ?? null,
    rules: overrides,
    tokens: sumUsage(decision.usage), // real LLM usage, for `npm run cost`
  };
  const endpoint = `POST /tickets/${ticket.id}/${action}`;
  const onAttempt = (a) => db.recordAttempt({ ticketUuid, runId, endpoint, ...a });

  try {
    const { alreadyHandled } = await helpdesk.sendDecision(ticket.id, action, payload, onAttempt);
    const status = alreadyHandled ? "skipped_already_handled" : "sent";
    logTicket({ ...summary, ms: Date.now() - started, status });
    await db.recordDecision({ ticketUuid, runId, decision, status });
    return alreadyHandled ? "skipped" : "sent";
  } catch (err) {
    logTicket({ ...summary, ms: Date.now() - started, status: "error", stage: "send", http: err.status, error: err.code, problems: err.problems });
    await db.recordDecision({ ticketUuid, runId, decision, status: "failed" });
    if (err.status === 401) throw err; // wrong key: stop the whole run
    return "error"; // next run picks it up
  }
}

async function main() {
  const status = await helpdesk.getStatus();
  const tickets = await helpdesk.listOpenTickets();
  const runId = (await db.startRun("agent")) || `local-${Date.now()}`;
  console.log(`Run ${runId} | mode=${status.mode} open=${status.open_tickets} handled=${status.handled_tickets}`);
  console.log(`Processing ${tickets.length} open tickets. Log: ${LOG_FILE}\n`);

  const counts = { sent: 0, skipped: 0, error: 0 };
  try {
    for (const ticket of tickets) {
      counts[await processTicket(ticket, runId)]++;
    }
  } finally {
    await db.finishRun(runId, { total: tickets.length, processed: counts.sent + counts.skipped, failed: tickets.length - counts.sent - counts.skipped });
  }

  const after = await helpdesk.getStatus();
  console.log(`\nDone: sent=${counts.sent} skipped=${counts.skipped} errors=${counts.error} | helpdesk now open=${after.open_tickets} handled=${after.handled_tickets}`);
  if (counts.error > 0) {
    console.log("Some tickets failed and are still open. Run `npm start` again to continue.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Agent stopped:", err.message);
  process.exit(1);
});
