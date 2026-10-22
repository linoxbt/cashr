// End-to-end journey against a running web app and a *simulated* API.
//   API:  CASHR_CHAIN=sim CASHR_SECRET=dev CASHR_SCAN_INTERVAL=1 uvicorn cashr.main:app
//   Web:  NEXT_PUBLIC_API_URL=http://localhost:8000 npm run build && npm start
//   Run:  node e2e/journey.mjs   (BASE, API, CHROMIUM env vars override defaults)
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:3000";
const API = process.env.API || "http://localhost:8000";
const b = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
p.on("dialog", (d) => d.accept());
const step = (m) => console.log("✓", m);
const address = async () => (await (await fetch(`${API}/sim/address`)).json()).address;

try {
  // 1. Every tape on the landing page plays into an action page.
  const want = ["/new", "/join", "/door", "/tickets", "/events", "/events"];
  for (let i = 0; i < want.length; i++) {
    await p.goto(BASE + "/");
    await p.waitForTimeout(1200);
    for (let k = 0; k < i; k++) {
      await p.getByRole("button", { name: "Next tape" }).click();
      await p.waitForTimeout(700);
    }
    await p.waitForTimeout(500);
    await p.locator("[aria-live=polite] a").click();
    await p.waitForURL("**" + want[i], { timeout: 8000 });
  }
  step("all six tapes play into action pages");

  // 2. Tapes never cover the caption.
  let worst = -Infinity;
  for (const [w, h] of [[1440, 900], [1366, 768], [390, 844]]) {
    await p.setViewportSize({ width: w, height: h });
    await p.goto(BASE + "/");
    await p.waitForTimeout(1200);
    for (const s of [0, 0.5, 1, 1.5]) {
      await p.evaluate((s) => { document.querySelector(".crt-scroll").scrollTop = s * innerHeight * 0.55; }, s);
      await p.waitForTimeout(800);
      worst = Math.max(worst, await p.evaluate(() => {
        const cap = document.querySelector("[aria-live=polite]").getBoundingClientRect();
        let low = -Infinity;
        for (const t of document.querySelectorAll("[aria-roledescription=carousel] > button")) {
          if (parseFloat(getComputedStyle(t).opacity) < 0.05) continue;
          const r = t.getBoundingClientRect();
          if (r.right > cap.left && r.left < cap.right) low = Math.max(low, r.bottom);
        }
        return low - cap.top;
      }));
    }
  }
  if (worst > 0) throw new Error(`tapes overlap the caption by ${worst}px`);
  step("tapes never cover the caption");
  await p.setViewportSize({ width: 1440, height: 900 });

  // The demo (a simulated chain) points back to the real app and offers no "try the demo".
  await p.goto(BASE + "/");
  const back = await p.getByRole("link", { name: /Use the real app/ }).getAttribute("href");
  if (!/^https:\/\//.test(back ?? "")) throw new Error(`demo banner links to ${back}`);
  if (await p.getByTestId("demo-link").count()) throw new Error("the demo offers a link to itself");
  step("demo banner links to the real app");

  // 3. Host an event, remembered on this device.
  await p.goto(BASE + "/new");
  await p.fill("#title", "Friday tenants' meeting");
  await p.fill("#starts", "2026-10-30T18:00");
  await p.fill("#capacity", "25");
  await p.fill("#deposit", "0.005");
  await p.fill("#forfeit", await address());
  await p.getByRole("button", { name: "Create event" }).click();
  await p.getByText("is ready.").waitFor();
  await p.check("text=Remember these links on this device");
  const invite = (await p.locator(".mono-break").allTextContents())[0];
  step("hosted an event");

  // 4. RSVP and pay from /join, twice (one will be a no-show).
  const tickets = [];
  for (let i = 0; i < 2; i++) {
    if (i) await p.evaluate(() => localStorage.removeItem("cashr.tickets.v1"));
    await p.goto(BASE + "/join");
    await p.getByText("On air").waitFor();
    await p.fill("#open-link-e", invite);
    await p.click("text=Find event");
    await p.getByText("Where should your refund go?").waitFor();
    await p.fill("#refund", await address());
    await p.check("input[type=checkbox]");
    await p.click("text=Continue to deposit");
    await p.click("text=Simulate this payment");
    await p.getByText("You're going").waitFor({ timeout: 20000 });
    tickets.push(await p.evaluate(() => Object.values(JSON.parse(localStorage.getItem("cashr.tickets.v1")))[0]));
  }
  step("two attendees RSVP'd and paid");

  // 5. /tickets lists the ticket from this device alone, and asks the server only when told to.
  const listFetches = [];
  const onRequest = (r) => /\/events\/[a-z0-9]{10}\/tickets$/.test(r.url()) && listFetches.push(r.url());
  p.on("request", onRequest);
  await p.goto(BASE + "/tickets");
  await p.getByText("Friday tenants").first().waitFor();
  await p.waitForTimeout(1500);
  if (listFetches.length) throw new Error(`/tickets fetched ticket lists unprompted: ${listFetches.join(", ")}`);
  await p.getByRole("button", { name: "Check status" }).first().click();
  await p.getByText("Going", { exact: true }).waitFor({ timeout: 15000 });
  p.off("request", onRequest);
  step("/tickets shows GOING, fetched only on request");

  // 6. The door checks the first attendee in; a junk code is not "invalid ticket" but unknown.
  await p.goto(BASE + "/door");
  await p.getByRole("link", { name: "Start scanning" }).first().click();
  await p.waitForURL("**/door/**");
  await p.getByText("Friday tenants").waitFor();
  const t = tickets[0];
  await p.fill("input.input", `cashr:${t.eventId}:${t.secret}`);
  await p.getByRole("button", { name: "Check", exact: true }).click();
  await p.getByText("Welcome in").waitFor();
  step("door checked the ticket in");

  // 6b. Offline, the door decides from its saved list and syncs later. A ticket
  // it doesn't know is "can't confirm", never "not valid".
  await p.context().setOffline(true);
  await p.fill("#ticket-code", `cashr:${t.eventId}:${"A".repeat(43)}`);
  await p.getByRole("button", { name: "Check", exact: true }).click();
  await p.getByText("Can't confirm offline").waitFor();
  const t2 = tickets[1];
  await p.fill("#ticket-code", `cashr:${t2.eventId}:${t2.secret}`);
  await p.getByRole("button", { name: "Check", exact: true }).click();
  await p.getByText("Welcome in").waitFor();
  await p.getByText("1 check-in to sync").waitFor();
  await p.context().setOffline(false);
  await p.getByText("1 check-in to sync").waitFor({ state: "detached", timeout: 30000 });
  step("offline check-in queued, then synced");

  // 6c. A wrong-amount payment is returned, and the dashboard says so.
  const ev = await (await fetch(`${API}/events/${t.eventId}`)).json();
  const memo = `CSH1 ${t.eventId} ${"B".repeat(43)} ${await address()}`;
  const memoB64 = Buffer.from(memo).toString("base64url");
  await fetch(`${API}/sim/pay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: ev.address, amount_zat: ev.deposit_zat + 1, memo_b64url: memoB64 }),
  });
  const list = await (await fetch(`${API}/events/${t.eventId}/tickets`)).json();
  // Publicly only "returned": the specific reason stays with the organiser.
  if (!list.rejected.some((r) => r.reason === "returned")) throw new Error("wrong-amount payment was not rejected");
  step("wrong-amount payment rejected for return");

  // Everyone came, so no forfeit pays the refund fees: the organiser tops up
  // the event wallet (a payment with no memo), as the dashboard asks.
  await fetch(`${API}/sim/pay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: ev.address, amount_zat: 100_000, memo_b64url: "" }),
  });

  // 6d. A tampered manage link is refused.
  await p.goto(`${BASE}/manage/${t.eventId}#k=not-the-token`);
  await p.getByText("This manage link isn't valid").waitFor();
  step("bad manage link refused");

  // 7. End the event: the refund confirms, the no-show deposit is swept, then purge.
  await p.goto(BASE + "/events");
  await p.getByText("Friday tenants").first().waitFor();
  await p.getByRole("link", { name: "Manage" }).first().click();
  await p.waitForURL("**/manage/**");
  await p.click("text=Close RSVPs");
  await p.getByRole("button", { name: "Reopen RSVPs" }).waitFor();
  await p.click("text=Reopen RSVPs");
  await p.getByRole("button", { name: "Close RSVPs" }).waitFor();
  await p.click("text=Money");
  await p.getByText("Returned", { exact: true }).first().waitFor({ timeout: 15000 });
  step("dashboard closed and reopened RSVPs, and shows the returned payment");
  await p.click("text=End event & refund");
  // Long enough for a live demo (5 s blocks, real confirmation rules), not just CI.
  await p.getByText("settled", { exact: true }).waitFor({ timeout: 180000 });
  step("settled: refunds confirmed and leftover fees swept");
  await p.click("text=Purge all data");
  await p.getByText("Purged", { exact: true }).waitFor({ timeout: 15000 });
  await p.waitForTimeout(1500);
  if (await p.getByText("Wallet unreachable").isVisible()) throw new Error("dashboard shows a wallet error after purge");
  step("purged, wallet keys destroyed, dashboard clean");

  // 8. The attendee's ticket list reflects it.
  await p.evaluate((t) => localStorage.setItem("cashr.tickets.v1", JSON.stringify({ [t.eventId]: t })), tickets[0]);
  await p.goto(BASE + "/tickets");
  await p.getByRole("button", { name: "Check status" }).first().click();
  await p.getByText("Event over · ticket removed", { exact: true }).waitFor({ timeout: 15000 });
  // Purged on the server, so the ticket is gone from this device too.
  await p.reload();
  await p.getByText("No tickets on this device yet").waitFor();
  step("/tickets shows the event is over, and removes its ticket by itself");

  if (errors.length) throw new Error("page errors: " + errors.join("; "));
  console.log("JOURNEY OK");
  await b.close();
} catch (e) {
  console.log("FAILED:", e.message.split("\n")[0], "at", p.url());
  await p.screenshot({ path: "e2e-failure.png" }).catch(() => {});
  console.log("BODY:", (await p.locator("main, body").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 800));
  await b.close();
  process.exit(1);
}
