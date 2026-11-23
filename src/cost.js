// npm run cost: cost per 100 tickets from logged token usage (read-only).
// Default prices: gemini-3.5-flash-lite, USD per 1M tokens. Override with AI_PRICE_*_PER_M.
const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "../logs");

// Output = total - prompt, so thinking tokens are counted.
function sumUsage(usageList) {
  const list = (usageList || []).filter(Boolean);
  if (list.length === 0) return null;
  let input = 0;
  let output = 0;
  for (const u of list) {
    const prompt = Number(u.prompt_tokens) || 0;
    const completion = Number(u.completion_tokens) || 0;
    const total = Number(u.total_tokens) || 0;
    input += prompt;
    output += total > prompt ? total - prompt : completion;
  }
  return { input, output, calls: list.length };
}

function costPer100(entries, priceInPerM, priceOutPerM) {
  if (entries.length === 0) return null;
  const sum = entries.reduce((a, e) => ({ input: a.input + e.input, output: a.output + e.output, calls: a.calls + e.calls }), { input: 0, output: 0, calls: 0 });
  const avgIn = sum.input / entries.length;
  const avgOut = sum.output / entries.length;
  const perTicket = (avgIn * priceInPerM + avgOut * priceOutPerM) / 1e6;
  return { tickets: entries.length, calls: sum.calls, avgInput: avgIn, avgOutput: avgOut, perTicketUsd: perTicket, per100Usd: perTicket * 100 };
}

function readAgentLog() {
  const file = path.join(LOG_DIR, "agent.log");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((e) => e && e.tokens && e.tokens.calls > 0);
}

function readEvalFiles() {
  if (!fs.existsSync(LOG_DIR)) return [];
  return fs
    .readdirSync(LOG_DIR)
    .filter((f) => /^eval-.*\.json$/.test(f))
    .flatMap((f) => { try { return JSON.parse(fs.readFileSync(path.join(LOG_DIR, f), "utf8")).results || []; } catch { return []; } })
    .filter((r) => r.tokens && r.tokens.calls > 0);
}

function main() {
  const priceIn = Number(process.env.AI_PRICE_INPUT_PER_M ?? 0.3);
  const priceOut = Number(process.env.AI_PRICE_OUTPUT_PER_M ?? 2.5);
  console.log(`Prices (USD per 1M tokens): input ${priceIn}, output ${priceOut}\n`);

  for (const [label, rows] of [["Agent runs (logs/agent.log)", readAgentLog()], ["Evals (logs/eval-*.json)", readEvalFiles()]]) {
    const r = costPer100(rows.map((x) => x.tokens), priceIn, priceOut);
    if (!r) {
      console.log(`${label}: no token usage recorded yet (older entries have no "tokens" field).`);
      continue;
    }
    console.log(`${label}: ${r.tickets} tickets, ${r.calls} LLM calls`);
    console.log(`  avg tokens/ticket: input ${r.avgInput.toFixed(0)}, output ${r.avgOutput.toFixed(0)}`);
    console.log(`  cost per ticket: $${r.perTicketUsd.toFixed(5)}  ->  per 100 tickets: $${r.per100Usd.toFixed(3)}`);
  }
}

if (require.main === module) main();

module.exports = { sumUsage, costPer100 };
