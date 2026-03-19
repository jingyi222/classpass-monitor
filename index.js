const fetch = require("node-fetch");
const cron = require("node-cron");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CHECK_INTERVAL_MINS = parseInt(process.env.CHECK_INTERVAL_MINS || "30");
const INSTRUCTOR_NAME = process.env.INSTRUCTOR_NAME || "";
const RATING_FILTER = process.env.RATING_FILTER || "all";
const CLASSPASS_COOKIE = process.env.CLASSPASS_COOKIE;

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
let telegramOffset = 0;

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const chunks = [];
  let t = text;
  while (t.length > 4000) { chunks.push(t.substring(0, 4000)); t = t.substring(4000); }
  chunks.push(t);
  for (const chunk of chunks) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: chunk, parse_mode: "HTML" }),
      });
      const data = await res.json();
      if (!data.ok) console.error("[telegram] Error:", data.description);
      else console.log("[telegram] Sent.");
      await new Promise(r => setTimeout(r, 500));
    } catch (e) { console.error("[telegram] Failed:", e.message); }
  }
}

// ─── TELEGRAM COMMAND POLLING ─────────────────────────────────────────────────
async function pollTelegramCommands() {
  if (!TELEGRAM_TOKEN) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${telegramOffset}&timeout=5`);
    const data = await res.json();
    if (!data.ok || !data.result) return;
    for (const update of data.result) {
      telegramOffset = update.update_id + 1;
      const text = update.message?.text?.trim().toLowerCase();
      const chatId = update.message?.chat?.id?.toString();
      if (chatId !== TELEGRAM_CHAT_ID) continue;
      if (text === "/reviews") {
        console.log("[cmd] /reviews requested");
        await sendTelegram("🔍 Fetching all your reviews, one moment...");
        await sendAllReviews();
      } else if (text === "/help") {
        await sendTelegram(`📋 <b>Commands</b>\n\n/reviews — All past reviews mentioning ${INSTRUCTOR_NAME}\n/help — This message`);
      }
    }
  } catch (_) {}
}

// ─── FETCH PAGE ───────────────────────────────────────────────────────────────
async function fetchPageHTML(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
      "Cookie": `ndp_session=${CLASSPASS_COOKIE}`,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://classpass.com",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
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

  const prompt = `Extract all reviews from this ClassPass page for studio "${studioName}". The user is logged in so instructor names should be visible.

Return a JSON array with fields:
- id: unique string (combine stars+text+date, no spaces)
- stars: integer 1-5 (0 if not found)
- text: review text or empty string
- date: date string or empty string
- class_name: class name or empty string
- instructor: instructor name shown or empty string
- mentions_instructor: true if instructor field contains "${INSTRUCTOR_NAME}" (case-insensitive) OR review text mentions "${INSTRUCTOR_NAME}"

Return ONLY valid JSON array, no markdown. Return [] if no reviews found.

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

// ─── SEND ALL REVIEWS ─────────────────────────────────────────────────────────
async function sendAllReviews() {
  let grandTotal = 0;
  for (const studio of STUDIOS) {
    let html;
    try { html = await fetchPageHTML(studio.url); }
    catch (e) { await sendTelegram(`❌ Could not fetch ${studio.name}: ${e.message}`); continue; }
    let reviews;
    try { reviews = await parseReviewsWithClaude(html, studio.name); }
    catch (e) { await sendTelegram(`❌ Could not parse reviews for ${studio.name}`); continue; }

    const myReviews = reviews.filter(r => r.mentions_instructor);
    if (myReviews.length === 0) {
      await sendTelegram(`🏢 <b>${studio.name}</b>\n\nNo reviews found mentioning ${INSTRUCTOR_NAME}.`);
      continue;
    }
    grandTotal += myReviews.length;
    let msg = `🏢 <b>${studio.name}</b> — ${myReviews.length} review(s)\n${"─".repeat(28)}\n\n`;
    for (const r of myReviews) {
      const stars = "★".repeat(r.stars) + "☆".repeat(5 - (r.stars || 0));
      msg += `${stars}`;
      if (r.date) msg += ` · ${r.date}`;
      if (r.class_name) msg += `\n📍 ${r.class_name}`;
      msg += `\n${r.text || "(No written comment)"}\n\n`;
    }
    await sendTelegram(msg);
    await new Promise(r => setTimeout(r, 1000));
  }
  await sendTelegram(`✅ Done! Found <b>${grandTotal}</b> review(s) mentioning <b>${INSTRUCTOR_NAME}</b> across ${STUDIOS.length} studio(s).`);
}

// ─── CHECK ONE STUDIO ─────────────────────────────────────────────────────────
async function checkStudio(studio) {
  console.log(`[check] ${studio.name}`);
  if (!seenReviews[studio.name]) seenReviews[studio.name] = new Set();
  const seen = seenReviews[studio.name];
  let html;
  try { html = await fetchPageHTML(studio.url); }
  catch (e) { console.error(`[check] Fetch failed: ${e.message}`); return; }
  let reviews;
  try { reviews = await parseReviewsWithClaude(html, studio.name); }
  catch (e) { console.error(`[check] Parse error: ${e.message}`); return; }

  console.log(`[check] ${studio.name}: ${reviews.length} review(s)`);

  if (isFirstRun) {
    reviews.forEach(r => seen.add(r.id));
    console.log(`[check] Seeded ${reviews.length} for ${studio.name}`);
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
    ].filter(l => l !== null).join("\n");
    console.log(`[notify] New review at ${studio.name}`);
    await sendTelegram(msg);
  }
}

// ─── CHECK ALL ────────────────────────────────────────────────────────────────
async function checkAll() {
  console.log(`\n[${new Date().toISOString()}] Checking ${STUDIOS.length} studio(s)...`);
  for (const studio of STUDIOS) {
    await checkStudio(studio);
    await new Promise(r => setTimeout(r, 3000));
  }
  if (isFirstRun) {
    isFirstRun = false;
    await sendTelegram(`✅ <b>ClassPass Monitor is live!</b>\n\nWatching <b>${STUDIOS.length}</b> studio(s) for <b>${INSTRUCTOR_NAME}</b>\nChecking every <b>${CHECK_INTERVAL_MINS} minutes</b>\n\nSend /reviews to see all past reviews!\nSend /help for commands.`);
  }
}

// ─── VALIDATE ─────────────────────────────────────────────────────────────────
function validateConfig() {
  const errors = [];
  if (!TELEGRAM_TOKEN) errors.push("TELEGRAM_TOKEN");
  if (!TELEGRAM_CHAT_ID) errors.push("TELEGRAM_CHAT_ID");
  if (!ANTHROPIC_API_KEY) errors.push("ANTHROPIC_API_KEY");
  if (!CLASSPASS_COOKIE) errors.push("CLASSPASS_COOKIE");
  if (STUDIOS.length === 0) errors.push("STUDIOS");
  if (!INSTRUCTOR_NAME) errors.push("INSTRUCTOR_NAME");
  if (errors.length > 0) { console.error("❌ Missing:", errors.join(", ")); process.exit(1); }
  console.log(`✅ Watching ${STUDIOS.length} studio(s) for ${INSTRUCTOR_NAME} every ${CHECK_INTERVAL_MINS} mins`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 ClassPass Review Monitor starting...\n");
  validateConfig();
  await checkAll();
  cron.schedule(`*/${CHECK_INTERVAL_MINS} * * * *`, checkAll);
  setInterval(pollTelegramCommands, 10000);
  console.log(`\n⏰ Scheduled every ${CHECK_INTERVAL_MINS} minutes. Listening for commands.`);
}

process.on("SIGTERM", () => process.exit(0));
main().catch(e => { console.error("Fatal:", e); process.exit(1); });
