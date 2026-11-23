// npm run reset  ->  POST /practice/reset (re-opens all 30 practice tickets)
const helpdesk = require("./services/helpdeskClient");

helpdesk
  .resetPractice()
  .then(async (res) => {
    console.log("Reset:", JSON.stringify(res));
    console.log("Status:", JSON.stringify(await helpdesk.getStatus()));
  })
  .catch((err) => {
    console.error("Reset failed:", err.message);
    process.exit(1);
  });
