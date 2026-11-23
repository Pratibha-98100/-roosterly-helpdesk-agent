// Safety layer: the model proposes, plain-code rules decide.
const { FAQ_TEXT, FAQ_IDS } = require("./aiService");

const CONFIDENCE_THRESHOLD = Number(process.env.CONFIDENCE_THRESHOLD) || 0.7;

const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g;
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g; // 13-19 digits, spaces/dashes allowed

function redact(text) {
  return String(text || "")
    .replace(IBAN_RE, "[REDACTED_IBAN]")
    .replace(CARD_RE, "[REDACTED_CARD]");
}
const containsPaymentDetails = (text) => {
  IBAN_RE.lastIndex = 0;
  CARD_RE.lastIndex = 0;
  return IBAN_RE.test(text || "") || CARD_RE.test(text || "");
};

// Keyword backup for mandatory handoffs (nl/en/de). A hit always hands off.
const MANDATORY_KEYWORDS = {
  refund_or_disputed_charge:
    /terugbetal|geld terug|restitutie|terugstort|refund|chargeback|charged twice|dubbel afgeschreven|onterecht (afgeschreven|in rekening)|rückerstattung|geld zurück/i,
  cancellation_or_contract_change: /opzeg|contract (wijzig|opzeg|beëindig)|cancel (my|our|the) (subscription|contract|account)|kündig/i,
  personal_data_request: /\bavg\b|gdpr|dsgvo|persoonsgegevens|inzageverzoek|personal data|right to be forgotten|vergeetrecht|datenauskunft/i,
  security_incident: /gehackt|hacked|datalek|data ?breach|phishing|onbevoegd|unauthori[sz]ed (access|login)|account (is )?overgenomen/i,
  legal_threat: /advocaat|lawyer|attorney|rechtszaak|juridische stappen|legal action|rechter|anwalt|\bklage\b/i,
  threatening_to_leave: /overstap|andere aanbieder|stoppen met roosterly|switch(ing)? to (another|a competitor)|kündigen und wechseln/i,
};

function keywordReasons(text) {
  return Object.entries(MANDATORY_KEYWORDS)
    .filter(([, re]) => re.test(text))
    .map(([reason]) => reason);
}

// Stop-word language check.
const STOPWORDS = {
  nl: ["de", "het", "een", "en", "ik", "je", "jullie", "niet", "van", "voor", "met", "op", "onze", "hoe", "wat", "kan", "graag", "bij", "dat", "er", "zijn", "naar", "u", "uw", "ook", "dan", "wordt"],
  en: ["the", "and", "i", "you", "not", "to", "for", "with", "on", "my", "our", "how", "what", "can", "please", "it", "this", "that", "are", "your", "of", "be"],
  de: ["der", "die", "das", "und", "ich", "sie", "nicht", "ist", "für", "mit", "auf", "wir", "unser", "wie", "kann", "bitte", "ein", "eine", "zu", "es", "ihr", "ihre"],
};

function detectLanguage(text) {
  const words = String(text || "").toLowerCase().match(/[a-zäöüßéë]+/g) || [];
  const scores = {};
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    scores[lang] = words.filter((w) => list.includes(w)).length;
  }
  const [best, second] = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (best[1] < 2 || best[1] === second[1]) return null; // too short or unclear
  return best[0];
}

// Every "A → B" in a reply must be a real FAQ menu path.
const ITEM = "[A-Z][A-Za-z.]*(?: [a-z]+)?";
const CHAIN_RE = new RegExp(`${ITEM}(?: → ${ITEM})+`, "g");

function menuPairs(text) {
  const pairs = [];
  for (const chain of String(text).match(CHAIN_RE) || []) {
    const items = chain.split(" → ");
    for (let i = 0; i < items.length - 1; i++) pairs.push([items[i], items[i + 1]]);
  }
  return pairs;
}
const FAQ_PAIRS = menuPairs(FAQ_TEXT);

function unknownMenuSteps(reply) {
  return menuPairs(reply)
    .filter(([a, b]) => !FAQ_PAIRS.some(([fa, fb]) => a.endsWith(fa) && b.startsWith(fb)))
    .map(([a, b]) => `${a} → ${b}`);
}

const isEmptyTicket = (t) => !String(t.body || "").trim() && !String(t.subject || "").trim();

// Turns the model's proposal into the final { action, payload }.
function applyPolicy(ticket, ai) {
  const overrides = [];
  let action = ai.action;
  let priority = ai.priority;

  const ticketText = `${ticket.subject || ""}\n${ticket.body || ""}`;
  const mandatory = [...new Set([...(ai.mandatory_handoff_reasons || []), ...keywordReasons(ticketText)])];

  if (mandatory.length > 0) {
    // Rule 1: mandatory handoff. Confidence can never override this.
    if (action !== "handoff") overrides.push(`mandatory handoff (${mandatory.join(", ")})`);
    action = "handoff";
    const riskP1 = mandatory.includes("security_incident") || mandatory.includes("legal_threat");
    const minPriority = riskP1 ? "P1" : "P2";
    if (priority > minPriority) {
      overrides.push(`priority raised ${priority} -> ${minPriority}`);
      priority = minPriority;
    }
  } else if (action === "close") {
    // Rule 2: only close when the model is sure it is spam/empty.
    if (!ai.is_spam_or_empty || ai.confidence < CONFIDENCE_THRESHOLD) {
      overrides.push("close not certain -> handoff");
      action = "handoff";
    }
  } else if (action === "reply") {
    // Rule 3: a reply must be confident, grounded in the FAQ, and safe.
    const reply = ai.draft_reply || "";
    const validFaq = (ai.faq_ids || []).filter((id) => FAQ_IDS.includes(id));
    const replyLang = detectLanguage(reply);
    const badSteps = unknownMenuSteps(reply);

    const problems = [];
    if (ai.confidence < CONFIDENCE_THRESHOLD) problems.push(`low confidence ${ai.confidence}`);
    if (validFaq.length === 0) problems.push("no FAQ source");
    if (containsPaymentDetails(reply)) problems.push("payment details in reply");
    if (/\bF\d{2}\b/.test(reply)) problems.push("internal FAQ id in reply");
    if (badSteps.length) problems.push(`unknown menu steps: ${badSteps.join("; ")}`);
    if (replyLang && replyLang !== ai.language) problems.push(`reply language ${replyLang} != ${ai.language}`);

    if (problems.length) {
      overrides.push(`reply -> handoff (${problems.join(", ")})`);
      action = "handoff";
    }
  }

  const payload = {
    language: ai.language,
    category: ai.category,
    priority,
    reason: redact(ai.reason),
    confidence: ai.confidence,
  };
  if (action === "reply") payload.draft_reply = ai.draft_reply;
  if (action === "handoff") {
    const why = overrides.length ? ` [Agent: ${overrides.join("; ")}]` : "";
    payload.handoff_note = redact(ai.handoff_note) + why;
  }

  return { action, payload, overrides, mandatory };
}

// Used when the AI fails or returns invalid output twice: a safe handoff.
function fallbackHandoff(ticket, why) {
  const lang = detectLanguage(`${ticket.subject} ${ticket.body}`) || "nl";
  return {
    action: "handoff",
    payload: {
      language: lang,
      category: "other",
      priority: "P3",
      reason: `Automatic analysis failed (${why}); sent to a human to be safe.`,
      handoff_note: `The AI agent could not analyse this ticket (${why}). Please read and handle it manually. Subject: "${redact(ticket.subject)}".`,
    },
    overrides: [`fallback: ${why}`],
    mandatory: [],
  };
}

// Empty tickets are closed without calling the model.
function emptyTicketClose() {
  return {
    action: "close",
    payload: { language: "nl", category: "other", priority: "P4", reason: "Empty ticket: no subject and no message.", confidence: 1 },
    overrides: [],
    mandatory: [],
  };
}

module.exports = {
  CONFIDENCE_THRESHOLD,
  redact,
  containsPaymentDetails,
  keywordReasons,
  detectLanguage,
  unknownMenuSteps,
  isEmptyTicket,
  applyPolicy,
  fallbackHandoff,
  emptyTicketClose,
};
