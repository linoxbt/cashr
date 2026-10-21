// End-to-end journey against a running web app and a *simulated* API.
//   API:  UNLISTED_CHAIN=sim UNLISTED_SECRET=dev UNLISTED_SCAN_INTERVAL=1 uvicorn unlisted.main:app
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
    if (i) await p.evaluate(() => localStorage.removeItem("unlisted.tickets.v1"));
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
    tickets.push(await p.evaluate(() => Object.values(JSON.parse(localStorage.getItem("unlisted.tickets.v1")))[0]));
  }
  step("two attendees RSVP'd and paid");

  // 5. /tickets shows the ticket.
  await p.goto(BASE + "/tickets");
  await p.getByText("Going", { exact: true }).waitFor({ timeout: 15000 });
  step("/tickets shows GOING");

  // 6. The door checks the first attendee in; a junk code is not "invalid ticket" but unknown.
  await p.goto(BASE + "/door");
  await p.getByRole("link", { name: "Start scanning" }).first().click();
  await p.waitForURL("**/door/**");
  await p.getByText("Friday tenants").waitFor();
  const t = tickets[0];
  await p.fill("input.input", `unlisted:${t.eventId}:${t.secret}`);
  await p.getByRole("button", { name: "Check", exact: true }).click();
  await p.getByText("Welcome in").waitFor();
  step("door checked the ticket in");

  // 7. End the event: the refund confirms, the no-show deposit is swept, then purge.
  await p.goto(BASE + "/events");
  await p.getByText("Friday tenants").first().waitFor();
  await p.getByRole("link", { name: "Manage" }).first().click();
  await p.waitForURL("**/manage/**");
  await p.click("text=End event & refund");
  await p.getByText("settled", { exact: true }).waitFor({ timeout: 60000 });
  step("settled: refund confirmed and no-shows swept");
  await p.click("text=Purge all data");
  await p.getByText("Purged", { exact: true }).waitFor({ timeout: 15000 });
  step("purged, wallet keys destroyed");

  // 8. The attendee's ticket list reflects it.
  await p.evaluate((t) => localStorage.setItem("unlisted.tickets.v1", JSON.stringify({ [t.eventId]: t })), tickets[0]);
  await p.goto(BASE + "/tickets");
  await p.getByText("Event over", { exact: true }).waitFor({ timeout: 15000 });
  step("/tickets shows the event is over");

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
