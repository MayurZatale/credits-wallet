# Rules: Credits Wallet (take-home)

Small Node + TypeScript + Express + MongoDB server. Short and correct wins. Stay inside what the task asks.

## Scope
- Three URLs only: `POST /webhooks/payment`, `POST /spend`, `GET /wallet/:clientId`.
- Webhook: `{eventId, clientId, amount, status}`. ₹1 = 1 credit. `status` not `paid` → add nothing, log it. Bad signature → 401.
- Spend: `{clientId, ref, credits}`. Not enough credits → 402, take nothing. A repeat is charged once.
- Wallet: balance plus the last 20 entries, newest first.
- Also needed: a small gateway script that signs and sends payments, and `npm run check` printing PASS or FAIL.

## Size and shape
- About 150 to 250 lines of code in total, in a few plain files.
- No extra layers: no services, repositories, controllers, classes or abstractions.
- Do not add features, options or endpoints that were not asked for.

## Libraries
- Only `express`, `mongodb` and `dotenv` (plus TypeScript tooling already in `package.json`).
- No other libraries. Use Node built-ins such as `crypto` and `fetch`.

## Config
- Read all config from `.env`. The connection variable is `MONGO_URL`. The secret is `WEBHOOK_SECRET`.
- Commit `.env.example`, never `.env`.

## Time
- Store time as a number: `cS: Date.now()`. Never a `Date`.

## Money safety
- Balances change only through atomic updates (`$inc` with a condition in the filter). Never read, then write.
- Every payment and every spend is one entry with a unique key, and a unique index rejects repeats in the database itself. Do not check for repeats in code first.
- A duplicate key error means "already done": reply with success and change nothing.
- Balance must never go below zero. Spend must be conditional on enough credits in the same atomic update.

## Webhook signature
- Check `X-Signature` (HMAC-SHA256, hex) over the raw body, with `crypto.timingSafeEqual`, before any parsing.
- Capture the raw body (for example `express.raw`). Parse JSON only after the check passes.
- Compare buffers of equal length; a wrong length is a failure, not a throw.

## Indexes
- Every database query must use an index. Create them at startup.
- Keep a list of each `db.<collection>.createIndex(...)` for the README.

## Logs
- One short line per request: method, path, clientId, eventId or ref, outcome (credited, duplicate, ignored, refused, 401), and the balance after.
- It must be enough to explain why someone got double credits.
- Never log the secret, the signature, or the full body.

## Working style
- Do not write code until asked. Make small commits and keep all of them.
- Explain any line I ask about. I read every line before committing.
