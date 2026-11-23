// npm run eval: scores decisions on the 10 labelled examples. Posts nothing.
const fs = require("fs");
const path = require("path");
const helpdesk = require("./services/helpdeskClient");
const { decideTicket } = require("./services/decisionService");
const db = require("./services/dbService");
const { sumUsage } = require("./cost");

const FIELDS = ["language", "category", "priority", "action"];

async function main() {
  const runLabel = process.argv[2] || "eval";
  const { examples } = await helpdesk.getExamples();
  const runId = await db.startRun("eval");
  console.log(`Evaluating ${examples.length} labelled examples (label: ${runLabel})\n`);

  const results = [];
  for (const ex of examples) {
    const d = await decideTicket(ex);
    const predicted = { ...d.payload, action: d.action };
    const wrong = FIELDS.filter((f) => predicted[f] !== ex.label[f]);
    await db.recordEvalResult({
      runId,
      exampleId: ex.id,
      expected: ex.label,
      actual: { ...predicted, rules: d.overrides },
      passed: wrong.length === 0,
      failureReason: wrong.length ? wrong.map((f) => `${f}: expected ${ex.label[f]}, got ${predicted[f]}`).join("; ") : null,
    });
    results.push({
      id: ex.id,
      expected: ex.label,
      predicted: { language: predicted.language, category: predicted.category, priority: predicted.priority, action: predicted.action },
      wrong,
      overrides: d.overrides,
      reply: d.payload.draft_reply || null,
      reply_english: d.ai?.draft_reply_english || null,
      tokens: sumUsage(d.usage),
    });
    console.log(`${wrong.length ? "✖" : "✔"} ${ex.id} ${FIELDS.map((f) => `${f}=${predicted[f]}`).join(" ")}` +
      (wrong.length ? `   expected: ${wrong.map((f) => `${f}=${ex.label[f]}`).join(" ")}` : "") +
      (d.overrides.length ? `   [rules: ${d.overrides.join("; ")}]` : ""));
  }

  // Accuracy per field, plus "safe": no reply/close where Nordavo expects a handoff.
  console.log("\nAccuracy");
  const summary = {};
  for (const f of FIELDS) {
    const ok = results.filter((r) => !r.wrong.includes(f)).length;
    summary[f] = ok / results.length;
    console.log(`  ${f.padEnd(9)} ${ok}/${results.length}`);
  }
  const allOk = results.filter((r) => r.wrong.length === 0).length;
  const unsafe = results.filter((r) => r.expected.action === "handoff" && r.predicted.action !== "handoff");
  summary.exact = allOk / results.length;
  summary.unsafe = unsafe.length;
  console.log(`  all 4     ${allOk}/${results.length}`);
  console.log(`  UNSAFE (expected handoff, agent answered/closed): ${unsafe.length}`);

  console.log("\nReplies (English back-translation, to check Dutch without reading it)");
  for (const r of results.filter((x) => x.reply)) console.log(`  ${r.id}: ${r.reply_english}`);

  await db.finishRun(runId, { total: results.length, processed: allOk, failed: results.length - allOk });
  const file = path.join(__dirname, "../logs", `eval-${runLabel}.json`);
  fs.writeFileSync(file, JSON.stringify({ runLabel, at: new Date().toISOString(), summary, results }, null, 2));
  console.log(`\nSaved ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error("Eval failed:", err.message);
  process.exit(1);
});
