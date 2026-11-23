// Supabase tracking, best-effort: failures only warn. Ticket text is never stored.
const { createClient } = require("@supabase/supabase-js");
const config = require("../config/env");
const { redact } = require("./policyService");

config.requireEnv(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);

const supabase = createClient(config.supabase.url, config.supabase.key, {
  auth: { persistSession: false },
});

async function safe(label, query) {
  const { data, error } = await query;
  if (error) {
    console.error(`[db] ${label} failed: ${error.message}`);
    return null;
  }
  return data;
}

// A run id is only a real DB id if it is a uuid (it is "local-..." when Supabase was down).
const isUuid = (id) => /^[0-9a-f-]{36}$/i.test(String(id));

const RUN_TYPE = { agent: "final", eval: "evaluation", test: "test" };

async function startRun(runType) {
  const row = await safe("startRun", supabase.from("agent_runs").insert({ run_type: RUN_TYPE[runType] || "test", status: "running" }).select("id").single());
  return row?.id || null;
}

async function finishRun(runId, { total, processed, failed }) {
  if (!isUuid(runId)) return;
  await safe(
    "finishRun",
    supabase
      .from("agent_runs")
      .update({
        status: failed > 0 ? "failed" : "completed",
        completed_at: new Date().toISOString(),
        total_tickets: total,
        processed_tickets: processed,
        failed_tickets: failed,
      })
      .eq("id", runId)
  );
}

// Returns our internal uuid for a helpdesk ticket id like "T005" (creates it once).
async function upsertTicket(ticket) {
  const found = await safe("findTicket", supabase.from("tickets").select("id").eq("external_ticket_id", ticket.id).maybeSingle());
  if (found?.id) return found.id;
  const created = await safe(
    "insertTicket",
    supabase
      .from("tickets")
      .insert({
        external_ticket_id: ticket.id,
        received_at: ticket.received_at || null,
        channel: ticket.channel || null,
        customer_plan: ticket.customer_plan || null,
      })
      .select("id")
      .single()
  );
  return created?.id || null;
}

async function recordAttempt({ ticketUuid, runId, endpoint, attempt, ok, httpStatus, errorCode, errorMessage }) {
  if (!ticketUuid || !isUuid(runId)) return;
  await safe(
    "recordAttempt",
    supabase.from("processing_attempts").insert({
      ticket_id: ticketUuid,
      run_id: runId,
      attempt_number: attempt,
      endpoint,
      status: ok ? "success" : "failed",
      http_status: httpStatus || null,
      error_code: errorCode || null,
      error_message: errorMessage ? redact(errorMessage).slice(0, 500) : null,
    })
  );
}

// One row per ticket (upsert), so a re-run updates a failed row.
const DB_STATUS = { sent: "completed", skipped_already_handled: "completed", failed: "failed" };

async function recordDecision({ ticketUuid, runId, decision, status }) {
  if (!ticketUuid || !isUuid(runId)) return;
  const { action, payload, overrides, ai } = decision;
  const notes = [...overrides];
  if (status === "skipped_already_handled") notes.push("already handled in helpdesk (409), nothing sent");
  await safe(
    "recordDecision",
    supabase.from("ticket_decisions").upsert({
      ticket_id: ticketUuid,
      run_id: runId,
      language: payload.language,
      category: payload.category,
      priority: payload.priority,
      action,
      reason: payload.reason,
      draft_reply: payload.draft_reply ? redact(payload.draft_reply) : null,
      draft_reply_english: action === "reply" && ai?.draft_reply_english ? redact(ai.draft_reply_english) : null,
      handoff_note: payload.handoff_note || null,
      uncertainty_reason: notes.length ? notes.join("; ") : null,
      confidence: payload.confidence ?? null,
      status: DB_STATUS[status] || "failed",
    }, { onConflict: "ticket_id" })
  );
}

async function recordEvalResult({ runId, exampleId, expected, actual, passed, failureReason }) {
  if (!isUuid(runId)) return;
  await safe(
    "recordEvalResult",
    supabase.from("evaluation_results").insert({
      run_id: runId,
      example_id: exampleId,
      expected_result: expected,
      actual_result: actual,
      passed,
      failure_reason: failureReason || null,
    })
  );
}

module.exports = { startRun, finishRun, upsertTicket, recordAttempt, recordDecision, recordEvalResult };
