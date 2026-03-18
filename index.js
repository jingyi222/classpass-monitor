const fetch = require("node-fetch");
const cron = require("node-cron");
const puppeteer = require("puppeteer");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CHECK_INTERVAL_MINS = parseInt(process.env.CHECK_INTERVAL_MINS || "30");
const INSTRUCTOR_NAME = process.env.INSTRUCTOR_NAME || "";
const RATING_FILTER = process.env.RATING_FILTER || "all";
const CLASSPASS_EMAIL = process.env.CLASSPASS_EMAIL;
const CLASSPASS_PASSWORD = process.env.CLASSPASS_PASSWORD;

const STUDIOS = (process.env.STUDIOS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [name, ...rest] = s.split("|");
    return { name: name.trim(), url: rest.join("|").trim() };
  });

// ─── STATE ────────────────────────────────────────────────────────────────────
const seenReviews = {};
let isFirstRun = true;
let browser = null;
let page = null;
let loggedIn = false;
let telegramOffset = 0;

// ─── TELEGRAM SEND ────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  // Telegram max message length is 4096 — split if needed
  const chunks = [];
  while (text.length > 4000) {
    chunks.push(text.substring(0, 4000));
    text = text.substring(4000);
  }
  chunks.push(text);

  for (const chunk of chunks) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: chunk, parse_mode: "HTML" }),
      });
      const data = await res.json();
      if (!data.ok) console.error("[telegram] Error:", data.description);
      else console.log("[telegram] Message sent.");
      await new Promise((r) => setTimeout(r, 500)); // avoid rate limit
    } catch (e) {
      console.error("[telegram] Failed:", e.message);
    }
  }
}

// ─── TELEGRAM POLL FOR COMMANDS ───────────────────────────────────────────────
async function pollTelegramCommands() {
  if (!TELEGRAM_TOKEN) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${telegramOffset}&timeout=5`
    );
    const data = await res.json();
    if (!data.ok || !data.result) return;

    for (const update of data.result) {
      telegramOffset = update.update_id + 1;
      const text = update.message?.text?.trim().toLowerCase();
      const chatId = update.message?.chat?.id?.toString();

      // Only respond to the configured chat
      if (chatId !== TELEGRAM_CHAT_ID) continue;

      if (text === "/reviews" || text === "/reviews@" + (await getBotUsername())) {
        console.log("[command] /reviews requested");
        await sendTelegram("🔍 Fetching all your reviews now, give me a moment...");
        await sendAllReviews();
      } else if (text === "/help") {
        await sendTelegram(
          `📋 <b>ClassPass Monitor Commands</b>\n\n/reviews — Fetch all past reviews mentioning ${INSTRUCTOR_NAME}\n/help — Show this message`
        );
      }
    }
  } catch (e) {
    // Silently ignore polling errors
  }
}

let cachedBotUsername = null;
async function getBotUsername() {
  if (cachedBotUsername) return cachedBotUsername;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe`);
    const data = await res.json();
    cachedBotUsername = data.result?.username || "";
  } catch (_) {}
  return cachedBotUsername;
}

// ─── SEND ALL REVIEWS ─────────────────────────────────────────────────────────
async function sendAllReviews() {
  if (!loggedIn) {
    const ok = await loginToClassPass();
    if (!ok) {
      await sendTelegram("❌ Could not log in to ClassPass. Check your credentials.");
      return;
    }
  }

  let grandTotal = 0;
  for (const studio of STUDIOS) {
    let html;
    try {
      html = await fetchPageHTML(studio.url);
    } catch (e) {
      await sendTelegram(`❌ Could not fetch ${studio.name}: ${e.message}`);
      continue;
    }

    let reviews;
    try {
      reviews = await parseReviewsWithClaude(html, studio.name);
    } catch (e) {
      await sendTelegram(`❌ Could not parse reviews for ${studio.name}`);
      continue;
    }

    // Filter to only reviews mentioning the instructor
    const myReviews = reviews.filter((r) => r.mentions_instructor);

    if (myReviews.length === 0) {
      await sendTelegram(`🏢 <b>${studio.name}</b>\n\nNo reviews found mentioning ${INSTRUCTOR_NAME} on this page.`);
      continue;
    }

    grandTotal += myReviews.length;

    // Build one message per studio
    let msg = `🏢 <b>${studio.name}</b> — ${myReviews.length} review(s)\n${"─".repeat(30)}\n\n`;
    for (const r of myReviews) {
      const stars = "★".repeat(r.stars) + "☆".repeat(5 - (r.stars || 0));
      msg += `${stars}`;
      if (r.date) msg += ` · ${r.date}`;
      if (r.class_name) msg += `\n📍 ${r.class_name}`;
      msg += `\n${r.text || "(No written comment)"}`;
      msg += `\n\n`;
    }

    await sendTelegram(msg);
    await new Promise((r) => setTimeout(r, 1000));
  }

  await sendTelegram(`✅ Done! Found <b>${grandTotal}</b> total review(s) mentioning <b>${INSTRUCTOR_NAME}</b> across ${STUDIOS.length} studio(s).`);
}

// ─── BROWSER SETUP ────────────────────────────────────────────────────────────
async function launchBrowser() {
  console.log("[browser] Launching...");
  browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1");
  await page.setViewport({ width: 390, height: 844 });
  console.log("[browser] Ready.");
}

// ─── CLASSPASS LOGIN ──────────────────────────────────────────────────────────
async function loginToClassPass() {
  if (loggedIn) return true;
  if (!CLASSPASS_EMAIL || !CLASSPASS_PASSWORD) return false;
  try {
    console.log("[login] Logging in to ClassPass...");
    await page.goto("https://classpass.com/login", { waitUntil: "networkidle2", timeout: 30000 });
    try {
      await page.waitForSelector('[data-testid="accept-cookies"]', { timeout: 3000 });
      await page.click('[data-testid="accept-cookies"]');
    } catch (_) {}
    await page.waitForSelector('input[type="email"]', { timeout: 10000 });
    await page.type('input[type="email"]', CLASSPASS_EMAIL, { delay: 50 });
    await page.type('input[type="password"]', CLASSPASS_PASSWORD, { delay: 50 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
      page.keyboard.press("Enter"),
    ]);
    if (page.url().includes("/login")) {
      await sendTelegram("⚠️ ClassPass login failed. Check CLASSPASS_EMAIL and CLASSPASS_PASSWORD in Railway.");
      return false;
    }
    console.log("[login] Logged in!");
    loggedIn = true;
    return true;
  } catch (e) {
    console.error("[login] Error:", e.message);
    loggedIn = false;
    return false;
  }
}

// ─── FETCH PAGE ───────────────────────────────────────────────────────────────
async function fetchPageHTML(url) {
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await page.evaluate(() => window.scrollBy(0, 1000));
  await new Promise((r) => setTimeout(r, 2000));
  return await page.content();
}

// ─── PARSE REVIEWS VIA CLAUDE ─────────────────────────────────────────────────
async function parseReviewsWithClaude(html, studioName) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<img[^>]*>/gi, "")
    .substring(0, 14000);

  const prompt = `Extract all reviews from this ClassPass page for studio "${studioName}". User is logged in so instructor names are visible.

Return a JSON array with fields:
- id: unique string (combine stars+text+date)
- stars: integer 1-5 (0 if not found)
- text: review text or empty string
- date: date string or empty string
- class_name: class name or empty string
- instructor: instructor name shown or empty string
- mentions_instructor: true if instructor field contains "${INSTRUCTOR_NAME}" (case-insensitive) OR review text mentions "${INSTRUCTOR_NAME}"

Return ONLY valid JSON array, no markdown. Return [] if no reviews.

HTML:
${stripped}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const raw = data.content?.[0]?.text || "[]";
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// ─── CHECK ONE STUDIO ─────────────────────────────────────────────────────────
async function checkStudio(studio) {
  console.log(`[check] Checking: ${studio.name}`);
  if (!seenReviews[studio.name]) seenReviews[studio.name] = new Set();
  const seen = seenReviews[studio.name];

  let html;
  try {
    html = await fetchPageHTML(studio.url);
  } catch (e) {
    console.error(`[check] Fetch failed for ${studio.name}: ${e.message}`);
    loggedIn = false;
    await loginToClassPass();
    return;
  }

  let reviews;
  try {
    reviews = await parseReviewsWithClaude(html, studio.name);
  } catch (e) {
    console.error(`[check] Parse error for ${studio.name}: ${e.message}`);
    return;
  }

  console.log(`[check] ${studio.name}: ${reviews.length} review(s) found`);

  if (isFirstRun) {
    reviews.forEach((r) => seen.add(r.id));
    console.log(`[check] Seeded ${reviews.length} existing review(s) for ${studio.name}`);
    return;
  }

  for (const review of reviews) {
    if (seen.has(review.id)) continue;
    seen.add(review.id);
    if (!review.mentions_instructor) continue;
    if (RATING_FILTER === "positive" && review.stars < 4) continue;
    if (RATING_FILTER === "negative" && review.stars > 3) continue;

    const stars = "★".repeat(review.stars) + "☆".repeat(5 - review.stars);
    const msg = [
      `🎯 <b>New ClassPass Review for ${INSTRUCTOR_NAME}!</b>`,
      `🏢 <b>${studio.name}</b>`,
      ``,
      `${stars} (${review.stars}/5)`,
      review.class_name ? `📍 ${review.class_name}` : null,
      review.date ? `📅 ${review.date}` : null,
      ``,
      review.text ? `"${review.text}"` : `(No written comment)`,
    ].filter((l) => l !== null).join("\n");

    console.log(`[notify] New review at ${studio.name}: ${review.stars}★`);
    await sendTelegram(msg);
  }
}

// ─── CHECK ALL ────────────────────────────────────────────────────────────────
async function checkAll() {
  console.log(`\n[${new Date().toISOString()}] Checking ${STUDIOS.length} studio(s)...`);
  if (!loggedIn) {
    const ok = await loginToClassPass();
    if (!ok) { console.error("[check] Skipping — not logged in."); return; }
  }
  for (const studio of STUDIOS) {
    await checkStudio(studio);
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (isFirstRun) {
    isFirstRun = false;
    console.log("[init] First run complete. Now watching for NEW reviews.");
    await sendTelegram(
      `✅ <b>ClassPass Monitor is live!</b>\n\nLogged in as <b>${CLASSPASS_EMAIL}</b>\nWatching <b>${STUDIOS.length}</b> studio(s) for <b>${INSTRUCTOR_NAME}</b>\nChecking every <b>${CHECK_INTERVAL_MINS} minutes</b>\n\nSend /reviews anytime to see all your past reviews!\nSend /help for commands.`
    );
  }
}

// ─── VALIDATE ─────────────────────────────────────────────────────────────────
function validateConfig() {
  const errors = [];
  if (!TELEGRAM_TOKEN) errors.push("TELEGRAM_TOKEN");
  if (!TELEGRAM_CHAT_ID) errors.push("TELEGRAM_CHAT_ID");
  if (!ANTHROPIC_API_KEY) errors.push("ANTHROPIC_API_KEY");
  if (!CLASSPASS_EMAIL) errors.push("CLASSPASS_EMAIL");
  if (!CLASSPASS_PASSWORD) errors.push("CLASSPASS_PASSWORD");
  if (STUDIOS.length === 0) errors.push("STUDIOS");
  if (!INSTRUCTOR_NAME) errors.push("INSTRUCTOR_NAME");
  if (errors.length > 0) { console.error("❌ Missing:", errors.join(", ")); process.exit(1); }
  console.log(`✅ Watching ${STUDIOS.length} studio(s) for ${INSTRUCTOR_NAME} every ${CHECK_INTERVAL_MINS} mins`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 ClassPass Review Monitor starting...\n");
  validateConfig();
  await launchBrowser();
  await checkAll();

  // Schedule review checks
  cron.schedule(`*/${CHECK_INTERVAL_MINS} * * * *`, checkAll);

  // Poll for Telegram commands every 10 seconds
  setInterval(pollTelegramCommands, 10000);

  console.log(`\n⏰ Scheduled every ${CHECK_INTERVAL_MINS} minutes. Listening for /reviews command.`);
}

process.on("SIGTERM", async () => { if (browser) await browser.close(); process.exit(0); });
main().catch(async (e) => { console.error("Fatal:", e); if (browser) await browser.close(); process.exit(1); });
