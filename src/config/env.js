require("dotenv").config();

// Fail at startup if a required variable is missing.
function requireEnv(names) {
  const missing = names.filter((name) => !process.env[name] || !process.env[name].trim());
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")} (see .env.example)`);
  }
}

module.exports = {
  requireEnv,
  helpdesk: {
    baseUrl: process.env.HELPDESK_BASE_URL,
    apiKey: process.env.HELPDESK_API_KEY,
    email: process.env.CANDIDATE_EMAIL,
    name: process.env.CANDIDATE_NAME?.trim(),
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    model: process.env.OPENAI_MODEL || "gemini-3.5-flash-lite",
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
  port: Number(process.env.PORT) || 3000,
};
