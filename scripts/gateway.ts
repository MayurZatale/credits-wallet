import "dotenv/config";
import { createHmac } from "node:crypto";

// Acts as the payment gateway: signs the exact body bytes and posts them.
export function sendPayment(url: string, body: object, secret = process.env.WEBHOOK_SECRET!) {
  const raw = JSON.stringify(body);
  const sig = createHmac("sha256", secret).update(raw).digest("hex");
  return fetch(`${url}/webhooks/payment`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": sig },
    body: raw,
  });
}

// Usage: npm run gateway -- evt_1 c_17 500 [status]
if (import.meta.filename === process.argv[1]) {
  const [eventId, clientId, amount, status = "paid"] = process.argv.slice(2);
  const res = await sendPayment(`http://localhost:${process.env.PORT ?? 3000}`, { eventId, clientId, amount: Number(amount), status });
  console.log(res.status, await res.text());
}
