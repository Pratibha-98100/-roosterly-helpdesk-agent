# Roosterly helpdesk agent

Reads every open ticket from the Roosterly helpdesk and sends exactly one decision per ticket: **reply** (customer's language), **handoff** (English note for a human) or **close** (spam/empty). Node.js, Gemini via the OpenAI SDK, Supabase for internal tracking.

## How to run
```
npm install
cp .env.example .env      # fill in the helpdesk key, email, Gemini key, Supabase
npm start                 # the agent: handles all open tickets once
npm run eval              # eval on the 10 labelled examples (posts nothing)
npm test                  # 26 unit tests, no network
npm run cost              # cost per 100 tickets from recorded token usage
```

## Decisions
1. **The model proposes, code decides.** The LLM returns JSON; `policyService.js` then applies the client's rules in plain code, so a ticket cannot talk its way past them. Mandatory handoffs (refund, cancellation, GDPR/AVG, security, legal threat, threatening to leave) are flagged by the model **and** by a keyword net in nl/en/de. A reply becomes a handoff if confidence < 0.7, it cites no FAQ entry, it uses a menu path not in the FAQ, or it is in the wrong language. Close only when the model is sure it is spam/empty.
2. **FAQ only.** The prompt contains only `docs/faq.md`; anything it does not answer is a handoff.
3. **Agent and eval share one code path** (`decisionService.js`), so the eval measures what runs in production.

**Dutch:** no separate translation step; the model reads the ticket and writes the reply directly in the customer's language, and in the same call returns an English back-translation that is stored next to each reply so a non-Dutch speaker can check it; menu names must match the FAQ exactly (checked in code). Cost of this choice: one LLM call per ticket instead of two (translate + answer), some extra output tokens for the back-translation (included in the cost below), and the risk that a fluent-looking reply has a subtle error only a Dutch speaker would notice. **Security:** IBANs and card numbers are redacted before the LLM sees a ticket, and from logs and DB; a reply containing payment data is blocked. Ticket text is wrapped in `<ticket>` tags and treated as untrusted data. Keys live only in `.env`. **Assumptions:** confidence threshold 0.7; when unsure, hand off (a human costs a minute, a wrong answer costs a customer). **AI tools:** Gemini 3.5 Flash-Lite at runtime. Claude Code was my pair programmer: it proposed the structure, wrote code that I reviewed step by step, wrote the unit tests, and checked the code against the API reference; I made the design choices and can explain every file.

## Reliability
- **Pagination:** follows `next_cursor` until `null`.
- **409** already handled: never retried, logged as skipped. **429:** waits `Retry-After` (seconds or HTTP date). **503:** retried with backoff (nothing was saved). **400/422:** not retried, logged with `problems`; ticket stays open. **401:** stops the run.
- **Timeouts:** a POST that times out may have been saved, so the agent checks `GET /tickets/{id}` (`handled`) before sending again; a 409 on that retry counts as handled. A customer never gets two answers.
- **Crash recovery:** only open tickets are fetched, so a re-run continues where it stopped. If the LLM is down the ticket is left open instead of posting a fake handoff.
- Max 4 requests/second (limit is 5). Every attempt is recorded in Supabase and `logs/agent.log`.

## Eval and fix
Labels come from `GET /examples` (Nordavo), never from the model.

| Run | language | category | priority | action | all 4 | unsafe |
|---|---|---|---|---|---|---|
| before (`logs/eval-before.json`) | 10/10 | 2/10 | 1/10 | 3/10 | 0/10 | 0 |
| after (`logs/eval-after.json`) | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 | 0 |

**Failure found:** in the first run Gemini returned 503/429 errors, and the agent turned every error into a generic handoff, so categories and priorities were wrong and a human would get tickets the bot could answer. **Fix:** an LLM failure now leaves the ticket open for the next run instead of posting; calls are paced for the free-tier limit; and the priority rules in the prompt were made explicit (routine billing admin is not P2; something broken is never P4). Honest caveat: the prompt was tuned while looking at these 10 examples, so 10/10 is likely optimistic for new tickets.

**Cost:** measured on the 10 examples (`logs/eval-cost.json`): about 2,035 input + 234 output tokens per ticket. At Gemini 3.5 Flash-Lite paid pricing ($0.30 / $2.50 per 1M tokens) that is **≈ $0.12 per 100 tickets**; $0 on the free tier used here.

## What I would improve
A larger labelled set (e.g. 100 real tickets) held out from prompt tuning, so accuracy is measured on tickets the prompt was never tuned on, with a human spot-check of a sample of Dutch replies each week.
