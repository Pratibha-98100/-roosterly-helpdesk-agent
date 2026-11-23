// npm run status: read-only connectivity check
const helpdesk = require("./services/helpdeskClient");

async function main() {
  console.log("STATUS:", JSON.stringify(await helpdesk.getStatus(), null, 2));

  const tickets = await helpdesk.listOpenTickets();
  console.log(`OPEN TICKETS: ${tickets.length}`);
  if (tickets[0]) {
    console.log("FIRST TICKET FIELDS:", Object.keys(tickets[0]).join(", "));
    console.log("GET /tickets/{id}:", JSON.stringify(await helpdesk.getTicket(tickets[0].id), null, 2));
  }

  const examples = await helpdesk.getExamples();
  const list = Array.isArray(examples) ? examples : examples.examples || [];
  console.log(`EXAMPLES: ${list.length}`, list[0] ? `fields: ${Object.keys(list[0]).join(", ")}` : "");
}

main().catch((err) => {
  console.error("FAILED:", err.message, err.problems || "");
  process.exit(1);
});
