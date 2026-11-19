# Credits Wallet

A small server where a business buys credits and spends them. Node 20+, TypeScript, Express, MongoDB (Atlas). Only `express`, `mongodb` and `dotenv` are used at runtime.
The code was written with **GitHub Copilot**; I read and checked every line. The rules I gave it are in [CLAUDE.md](CLAUDE.md) (same text as `.github/copilot-instructions.md`).

## Run it

```
npm install
copy .env.example .env      # then fill in MONGO_URL (a replica set, e.g. Atlas) and WEBHOOK_SECRET
npm start                   # listens on PORT (default 3000)
npm run gateway -- evt_1 c_17 500          # fake gateway: signed payment of 500 credits
```

Spend and wallet calls (in Windows PowerShell `curl` is an alias for `Invoke-WebRequest`, so use `Invoke-RestMethod`):

```
# PowerShell
Invoke-RestMethod http://localhost:3000/spend -Method Post -ContentType application/json -Body '{"clientId":"c_17","ref":"job_88","credits":10}'
Invoke-RestMethod http://localhost:3000/wallet/c_17      # balance + last 20 entries, newest first

# bash / macOS / Linux
curl -X POST localhost:3000/spend -H "content-type: application/json" -d '{"clientId":"c_17","ref":"job_88","credits":10}'
curl localhost:3000/wallet/c_17
```

```
npm run check                              # starts its own server, prints PASS or FAIL for the 4 cases
```

Replies: webhook 401 on a bad signature; `/spend` 402 when credits are not enough; 400 on a bad body.
Each request logs one line, e.g. `1795078404748 POST /spend 200 ref=job_1 client=c_17 duplicate balance=- 38ms`, so a double credit can be traced by `event=` and `credited` / `duplicate`. The secret, signature and body are never logged.

## Indexes

Every query uses one of these:

```
db.entries.createIndex({ clientId: 1, cS: -1 })   // wallet history: find({clientId}).sort({cS:-1}).limit(20)
// built in, no createIndex needed:
//   db.entries  _id (unique)  -> the duplicate check; one insert per payment or spend
//   db.wallets  _id (unique)  -> balance read and the atomic $inc
```

The first one is created at startup. Time is stored as a number (`cS: Date.now()`), never a Date.

## How double credits are stopped

- Each payment or spend is **one entry** whose `_id` is a key: `pay:<eventId>` or `spend:<clientId>:<ref>`. `_id` is a unique index, so MongoDB itself rejects a repeat (error 11000). The code does not check first and then write, so 5 messages at the same moment still give one credit.
- The balance changes only with an atomic `$inc`. A spend's filter is `balance >= credits`, so the balance cannot go below zero. Not enough credits means no match, a 402 and nothing taken.
- The entry insert and the balance update run in **one transaction**. If the server crashes between them, both are rolled back, so there is never an entry without its balance change or the reverse.
- A repeat returns 200 `duplicate` (so the gateway stops retrying) and changes nothing.
- The webhook signature (HMAC-SHA256 hex of the raw body) is checked with `timingSafeEqual` before the JSON is parsed.

## What can still go wrong

- **Slow under contention.** All spends for one client update one wallet document, so concurrent transactions most likely conflict and are retried. 20 simultaneous spends took about 2.5 s in total. Results stay correct. I accepted this because the alternative (updating the balance without the transaction) could leave a balance change without its entry after a crash.
- **Needs a replica set.** Transactions do not work on a standalone `mongod`. Atlas is a replica set, so this is fine there.
- **First write wins.** A repeated `eventId` or `ref` with a different amount is ignored as a duplicate, not applied or flagged. The caller must reuse the same `ref` when retrying a job.
- **Huge amounts.** Amounts must be positive safe integers (below 2^53); anything else gets a 400. There is no upper limit below that.
- **Balance and history can differ briefly.** `GET /wallet` does two reads, so a write in between can show a balance one entry ahead of the list.
- **No auth on `/spend` and `/wallet`.** The task does not ask for it; only the webhook is signed. A real deployment needs it.
- **Test data stays.** `npm run check` uses fresh random client ids on the real database and does not delete them.

## Mistakes Copilot made

**1. Amount validation.** The first version validated amounts with `Number.isInteger`. That accepts huge values such as `1e300`, which lose precision above 2^53, so adding them to a balance would give wrong numbers. I caught it by asking what happens with odd inputs (`-10`, `0`, `2.5`, negative payments) and reading the code. The fix was `Number.isSafeInteger`. I then checked it with real requests: `/spend` with `1e300` and payments of `1e300` and `9007199254740993` all returned 400 and wrote nothing, and a normal spend of 10 for an unknown client still returned 402.

**2. Broken JSON gave a 500.** On `/spend`, `express.json()` rejects invalid JSON with a 400 error, but Copilot's catch-all error handler turned every error into a 500, which tells callers to retry. I found it by sending `{rdcvybininuoon}` myself, after Copilot had claimed bad bodies return 400 (it had only tested bad values, not bad JSON). The handler now keeps 4xx statuses and replies `{"error":"bad request body"}`; I re-sent the broken body and got a 400.
