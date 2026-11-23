// Validates the model output and the final POST body.

const LANGUAGES = ["nl", "en", "de"];
const CATEGORIES = ["bug", "billing", "feature_request", "question", "other"];
const PRIORITIES = ["P1", "P2", "P3", "P4"];
const ACTIONS = ["reply", "handoff", "close"];
const MANDATORY_REASONS = [
  "refund_or_disputed_charge",
  "cancellation_or_contract_change",
  "personal_data_request",
  "security_incident",
  "legal_threat",
  "threatening_to_leave",
];

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

function validateAiOutput(out) {
  const errors = [];
  if (!out || typeof out !== "object" || Array.isArray(out)) {
    return { valid: false, errors: ["output is not a JSON object"] };
  }

  if (!LANGUAGES.includes(out.language)) errors.push(`language must be one of ${LANGUAGES}`);
  if (!CATEGORIES.includes(out.category)) errors.push(`category must be one of ${CATEGORIES}`);
  if (!PRIORITIES.includes(out.priority)) errors.push(`priority must be one of ${PRIORITIES}`);
  if (!ACTIONS.includes(out.action)) errors.push(`action must be one of ${ACTIONS}`);
  if (!isNonEmptyString(out.reason)) errors.push("reason is required");
  if (typeof out.confidence !== "number" || out.confidence < 0 || out.confidence > 1) {
    errors.push("confidence must be a number between 0 and 1");
  }
  if (!Array.isArray(out.faq_ids)) errors.push("faq_ids must be an array");
  if (!Array.isArray(out.mandatory_handoff_reasons)) {
    errors.push("mandatory_handoff_reasons must be an array");
  } else {
    const unknown = out.mandatory_handoff_reasons.filter((r) => !MANDATORY_REASONS.includes(r));
    if (unknown.length) errors.push(`unknown mandatory_handoff_reasons: ${unknown}`);
  }
  // A handoff note is always required: the policy layer may turn any reply into a handoff.
  if (!isNonEmptyString(out.handoff_note)) errors.push("handoff_note is required");
  if (out.action === "reply") {
    if (!isNonEmptyString(out.draft_reply)) errors.push("draft_reply is required for reply");
    if (!isNonEmptyString(out.draft_reply_english)) errors.push("draft_reply_english is required for reply");
  }

  return { valid: errors.length === 0, errors };
}

// The exact body the helpdesk expects for each action (see api_reference.md).
function validateDecisionPayload(action, payload) {
  const errors = [];
  if (!ACTIONS.includes(action)) errors.push(`unknown action ${action}`);
  if (!LANGUAGES.includes(payload.language)) errors.push("invalid language");
  if (!CATEGORIES.includes(payload.category)) errors.push("invalid category");
  if (!PRIORITIES.includes(payload.priority)) errors.push("invalid priority");
  if (!isNonEmptyString(payload.reason)) errors.push("reason is required");

  if (action === "reply") {
    if (!isNonEmptyString(payload.draft_reply)) errors.push("reply needs draft_reply");
    if ("handoff_note" in payload) errors.push("reply must not have handoff_note");
  }
  if (action === "handoff") {
    if (!isNonEmptyString(payload.handoff_note)) errors.push("handoff needs handoff_note");
    if ("draft_reply" in payload) errors.push("handoff must not have draft_reply");
  }
  if (action === "close") {
    if ("draft_reply" in payload || "handoff_note" in payload) {
      errors.push("close must not have draft_reply or handoff_note");
    }
  }
  if ("confidence" in payload && (typeof payload.confidence !== "number" || payload.confidence < 0 || payload.confidence > 1)) {
    errors.push("confidence must be 0..1");
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateAiOutput,
  validateDecisionPayload,
  LANGUAGES,
  CATEGORIES,
  PRIORITIES,
  ACTIONS,
  MANDATORY_REASONS,
};
