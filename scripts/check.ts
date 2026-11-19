import type { AddressInfo } from "node:net";
import { start } from "../src/server.js";
import { sendPayment } from "./gateway.js";

const server = await start(0);
const url = `http://localhost:${(server.address() as AddressInfo).port}`;
// Fresh ids per run, so earlier runs' data in the shared database cannot change the balances checked here.
const newId = () => `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const spend = (clientId: string, ref: string, credits: number) =>
  fetch(`${url}/spend`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId, ref, credits }) });
const wallet = async (id: string) => (await fetch(`${url}/wallet/${id}`)).json() as Promise<{ balance: number; entries: unknown[] }>;
const pay = (id: string, amount: number) => sendPayment(url, { eventId: newId(), clientId: id, amount, status: "paid" });

let failed = 0;
const report = (name: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failed++;
};

{
  const id = newId();
  // Same body for all 5 sends: eventId is the dedupe key, so it must be identical.
  const body = { eventId: id, clientId: id, amount: 500, status: "paid" };
  await Promise.all([1, 2, 3, 4, 5].map(() => sendPayment(url, body)));
  const w = await wallet(id);
  report("same payment sent 5 times -> credited once", w.balance === 500 && w.entries.length === 1);
}
{
  const res = await fetch(`${url}/webhooks/payment`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": "00" },
    body: JSON.stringify({ eventId: newId(), clientId: "c_x", amount: 5, status: "paid" }),
  });
  report("wrong signature -> 401", res.status === 401);
}
{
  const id = newId();
  await pay(id, 100);
  // Fired together without awaiting each one, so the requests really overlap.
  const codes = (await Promise.all(Array.from({ length: 20 }, (_, i) => spend(id, `job_${i}`, 10)))).map((r) => r.status);
  const ok = codes.filter((c) => c === 200).length, refused = codes.filter((c) => c === 402).length;
  report("100 credits, 20 spends of 10 -> 10 pass, 10 refused, balance 0", ok === 10 && refused === 10 && (await wallet(id)).balance === 0);
}
{
  const id = newId();
  await pay(id, 100);
  await Promise.all([spend(id, "job_1", 10), spend(id, "job_1", 10)]);
  report("same spend sent twice -> charged once", (await wallet(id)).balance === 90);
}

server.close();
process.exit(failed ? 1 : 0);
