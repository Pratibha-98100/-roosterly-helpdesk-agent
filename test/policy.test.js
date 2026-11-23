// Offline tests for the safety rules.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"; // aiService checks it on load
const test = require("node:test");
const assert = require("node:assert");
const policy = require("../src/services/policyService");
const { validateAiOutput, validateDecisionPayload } = require("../src/validators/decisionValidator");

const baseAi = {
  language: "nl",
  category: "question",
  priority: "P4",
  action: "reply",
  reason: "How-to question answered by F02.",
  confidence: 0.9,
  faq_ids: ["F02"],
  mandatory_handoff_reasons: [],
  is_spam_or_empty: false,
  draft_reply: "Hoi Anouk, ga naar Team → Medewerker toevoegen en klik op Uitnodigen. Met vriendelijke groet, Team Roosterly",
  draft_reply_english: "Hi Anouk, go to Team → Add employee and click Invite.",
  handoff_note: "Customer asks how to add an employee.",
};
const ticket = { id: "T1", subject: "Nieuwe medewerker", body: "Hoe voeg ik een medewerker toe?" };

test("a grounded, confident Dutch reply stays a reply", () => {
  const d = policy.applyPolicy(ticket, baseAi);
  assert.strictEqual(d.action, "reply");
  assert.ok(validateDecisionPayload(d.action, d.payload).valid);
});

test("refund keyword forces handoff even with high confidence", () => {
  const t = { subject: "Vraag", body: "Kan ik mijn geld terug krijgen? Hoe voeg ik iemand toe?" };
  const d = policy.applyPolicy(t, { ...baseAi, confidence: 0.99 });
  assert.strictEqual(d.action, "handoff");
  assert.strictEqual(d.payload.priority, "P2");
  assert.ok(!("draft_reply" in d.payload));
});

test("model-flagged security incident becomes P1 handoff", () => {
  const d = policy.applyPolicy(ticket, { ...baseAi, mandatory_handoff_reasons: ["security_incident"] });
  assert.strictEqual(d.action, "handoff");
  assert.strictEqual(d.payload.priority, "P1");
});

test("low confidence reply becomes handoff", () => {
  assert.strictEqual(policy.applyPolicy(ticket, { ...baseAi, confidence: 0.5 }).action, "handoff");
});

test("invented menu path becomes handoff", () => {
  const ai = { ...baseAi, draft_reply: "Ga naar Instellingen → Geheime Knop en klik. Groet, Team Roosterly" };
  assert.strictEqual(policy.applyPolicy(ticket, ai).action, "handoff");
});

test("reply in the wrong language becomes handoff", () => {
  const ai = { ...baseAi, draft_reply: "Hi Anouk, you can add an employee in the Team menu. It is easy and you only pay for active staff." };
  assert.strictEqual(policy.applyPolicy(ticket, ai).action, "handoff");
});

test("close without spam certainty becomes handoff", () => {
  const ai = { ...baseAi, action: "close", is_spam_or_empty: false, draft_reply: null };
  assert.strictEqual(policy.applyPolicy(ticket, ai).action, "handoff");
});

test("IBAN and card numbers are redacted", () => {
  const out = policy.redact("IBAN NL91 ABNA 0417 1643 00 en kaart 4111 1111 1111 1111");
  assert.ok(!out.includes("0417") && !out.includes("4111"), out);
});

test("validator rejects bad values and missing reply", () => {
  const r = validateAiOutput({ ...baseAi, priority: "P9", draft_reply: "" });
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.errors.length, 2);
});

test("payload validator enforces fields per action", () => {
  assert.strictEqual(validateDecisionPayload("handoff", { language: "nl", category: "bug", priority: "P2", reason: "x" }).valid, false);
  assert.strictEqual(validateDecisionPayload("close", { language: "nl", category: "other", priority: "P4", reason: "spam" }).valid, true);
});

test("language detection", () => {
  assert.strictEqual(policy.detectLanguage("Hoe ruil ik een dienst met een collega?"), "nl");
  assert.strictEqual(policy.detectLanguage("The app crashes on my phone and I can not log in"), "en");
  assert.strictEqual(policy.detectLanguage("Ich kann mich nicht anmelden, bitte helfen Sie mir"), "de");
});
