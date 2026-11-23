// ticket -> validated decision. Shared by agent and eval. Never posts.
const { analyzeTicket } = require("./aiService");
const policy = require("./policyService");
const { validateAiOutput, validateDecisionPayload } = require("../validators/decisionValidator");

const MAX_AI_TRIES = 2;

async function decideTicket(rawTicket) {
  if (policy.isEmptyTicket(rawTicket)) return { ...policy.emptyTicketClose(), ai: null, usage: [] };

  // Redact payment details before the LLM sees the ticket.
  const ticket = { ...rawTicket, subject: policy.redact(rawTicket.subject), body: policy.redact(rawTicket.body) };

  const usage = [];
  let lastProblem = "unknown";
  for (let attempt = 1; attempt <= MAX_AI_TRIES; attempt++) {
    // LLM down: throw so the ticket stays open for the next run.
    const result = await analyzeTicket(ticket);
    if (result.usage) usage.push(result.usage);

    const check = validateAiOutput(result.output);
    if (!check.valid) {
      lastProblem = `invalid AI output: ${check.errors.join("; ")}`;
      continue;
    }

    const decision = policy.applyPolicy(ticket, result.output);
    const final = validateDecisionPayload(decision.action, decision.payload);
    if (!final.valid) {
      lastProblem = `invalid payload: ${final.errors.join("; ")}`;
      continue;
    }
    return { ...decision, ai: result.output, usage };
  }

  // The AI failed twice: hand off safely instead of guessing.
  const fallback = policy.fallbackHandoff(ticket, lastProblem.slice(0, 200));
  return { ...fallback, ai: null, usage };
}

module.exports = { decideTicket };
