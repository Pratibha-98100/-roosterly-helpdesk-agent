// One JSON line per ticket. Ticket and reply text are never logged.
const fs = require("fs");
const path = require("path");
const { redact } = require("./policyService");

const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "agent.log");
fs.mkdirSync(LOG_DIR, { recursive: true });

function logTicket(entry) {
  const line = redact(JSON.stringify({ at: new Date().toISOString(), ...entry }));
  fs.appendFileSync(LOG_FILE, line + "\n");
  console.log(line);
}

module.exports = { logTicket, LOG_FILE };
