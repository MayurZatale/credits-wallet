import "dotenv/config";
import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { MongoClient, MongoServerError } from "mongodb";

// Fail at startup, not on the first request, if config is missing.
const SECRET = process.env.WEBHOOK_SECRET;
if (!SECRET || !process.env.MONGO_URL) throw new Error("Set MONGO_URL and WEBHOOK_SECRET in .env");

const client = new MongoClient(process.env.MONGO_URL);
const db = client.db();
const wallets = db.collection<{ _id: string; balance: number }>("wallets");
const entries = db.collection<{ _id: string; clientId: string; type: string; credits: number; cS: number }>("entries");

type Outcome = "credited" | "charged" | "duplicate" | "refused";

// The entry and the balance change commit together or not at all, so a crash cannot split them.
// entries._id is the unique key: the database rejects a repeat of the same payment or spend.
// Concurrent calls on one wallet conflict; withTransaction retries those, which is why 20 spends take seconds.
async function apply(clientId: string, key: string, type: string, delta: number): Promise<{ outcome: Outcome; balance?: number }> {
  const done: Outcome = delta > 0 ? "credited" : "charged";
  try {
    return await client.withSession((s) =>
      s.withTransaction(async () => {
        // Insert first: a repeat then reports "duplicate" even when the balance is now too low for a 402.
        await entries.insertOne({ _id: key, clientId, type, credits: delta, cS: Date.now() }, { session: s });
        // Spends only match while balance >= credits, so the balance can never go below zero.
        // Upsert is for payments only: a spend on an unknown client must be refused, not create a wallet.
        const filter = delta < 0 ? { _id: clientId, balance: { $gte: -delta } } : { _id: clientId };
        const w = await wallets.findOneAndUpdate(filter, { $inc: { balance: delta } }, { upsert: delta > 0, returnDocument: "after", session: s });
        // Throwing aborts the transaction, which also rolls back the entry inserted above.
        if (!w) throw new Error("refused");
        return { outcome: done, balance: w.balance };
      }),
    );
  } catch (e) {
    // 11000 = duplicate key: this payment or spend was already applied, so change nothing.
    if (e instanceof MongoServerError && e.code === 11000) return { outcome: "duplicate" };
    if (e instanceof Error && e.message === "refused") return { outcome: "refused" };
    throw e;
  }
}

const app = express();
// Ids may not contain ":" so keys like "spend:<clientId>:<ref>" cannot collide across different clients.
const isId = (v: unknown): v is string => typeof v === "string" && /^[\w-]+$/.test(v);
const isAmount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

// One line per request, written on "finish" so it includes the status. res.locals.note says what happened to
// this payment or spend (credited, duplicate, ...). Never put the secret, signature or body in a note.
app.use((req, res, next) => {
  const t = Date.now();
  res.on("finish", () => console.log(`${t} ${req.method} ${req.path} ${res.statusCode} ${res.locals.note ?? ""} ${Date.now() - t}ms`));
  next();
});

// express.raw keeps the exact bytes: the signature covers them, and re-serialised JSON would not match.
app.post("/webhooks/payment", express.raw({ type: "*/*" }), async (req, res) => {
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const got = Buffer.from(String(req.get("x-signature") ?? ""), "hex");
  const want = createHmac("sha256", SECRET).update(raw).digest();
  // timingSafeEqual throws on different lengths (and bad hex decodes short), so compare lengths first.
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    res.locals.note = "bad signature";
    return res.sendStatus(401);
  }
  // Parse only after the signature passed, so unsigned input never reaches the JSON parser.
  let b: any;
  try { b = JSON.parse(raw.toString()); } catch { b = null; }
  if (!b || !isId(b.eventId) || !isId(b.clientId) || !isAmount(b.amount)) {
    res.locals.note = "bad body";
    return res.sendStatus(400);
  }
  // 200 for non-paid events (and duplicates below) so the gateway does not keep retrying them.
  if (b.status !== "paid") {
    res.locals.note = `event=${b.eventId} client=${b.clientId} ignored status=${b.status}`;
    return res.json({ outcome: "ignored" });
  }
  const r = await apply(b.clientId, `pay:${b.eventId}`, "payment", b.amount);
  res.locals.note = `event=${b.eventId} client=${b.clientId} ${r.outcome} balance=${r.balance ?? "-"}`;
  res.json(r);
});

app.post("/spend", express.json(), async (req, res) => {
  const b = req.body ?? {};
  if (!isId(b.clientId) || typeof b.ref !== "string" || !b.ref || !isAmount(b.credits)) {
    res.locals.note = "bad body";
    return res.sendStatus(400);
  }
  // The caller's ref is the dedupe key: a retried job must reuse the same ref or it is charged again.
  const r = await apply(b.clientId, `spend:${b.clientId}:${b.ref}`, "spend", -b.credits);
  res.locals.note = `ref=${b.ref} client=${b.clientId} ${r.outcome} balance=${r.balance ?? "-"}`;
  res.status(r.outcome === "refused" ? 402 : 200).json(r);
});

app.get("/wallet/:clientId", async (req, res) => {
  const id = req.params.clientId;
  // Two separate reads, so a write landing between them can show a balance one entry ahead of the list.
  const [wallet, list] = await Promise.all([
    wallets.findOne({ _id: id }),
    entries.find({ clientId: id }).sort({ cS: -1 }).limit(20).toArray(),
  ]);
  res.locals.note = `client=${id}`;
  res.json({ clientId: id, balance: wallet?.balance ?? 0, entries: list });
});

// Express 5 sends rejected async handlers and body-parser failures here. Body-parser errors (broken JSON,
// body too large) carry a 4xx status and are the caller's fault; anything else is ours, so a bare 500.
// The 4xx note leaves out err.message because it can echo part of the request body.
app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err.status && err.status >= 400 && err.status < 500) {
    res.locals.note = `bad request body status=${err.status}`;
    return res.status(err.status).json({ error: "bad request body" });
  }
  res.locals.note = `error=${err.message}`;
  res.sendStatus(500);
});

export async function start(port: number) {
  await client.connect();
  // Serves the wallet history query; the _id indexes cover every other query. Safe to repeat on each start.
  await entries.createIndex({ clientId: 1, cS: -1 });
  return app.listen(port);
}

// Only listen when run directly; scripts/check.ts imports start() and picks its own port.
if (import.meta.filename === process.argv[1]) {
  await start(Number(process.env.PORT ?? 3000));
  console.log("listening");
}
