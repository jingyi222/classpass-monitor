const fetch = require("node-fetch");
const cron = require("node-cron");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CHECK_INTERVAL_MINS = parseInt(process.env.CHECK_INTERVAL_MINS || "30");
const INSTRUCTOR_NAME = process.env.INSTRUCTOR_NAME || "";
const RATING_FILTER = process.env.RATING_FILTER || "all";
const CLASSPASS_COOKIE = process.env.CLASSPASS_COOKIE;

const STUDIOS = (process.env.STUDIOS || "")
  .split(",").map(s => s.trim()).filter(Boolean)
  .map(s => { const [name, ...rest] = s.split("|"); return { name: name.trim(), url: rest.join("|").trim() }; });

const seenReviews = {};
let isFirstRun = true;
let telegramOffset = 0;

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  let t = text;
  const chunks = [];
  while (t.length > 4000) { chunks.push(t.substring(0, 4000)); t = t.substring(4000); }
  chunks.push(t);
  for (const chunk of chunks) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: chunk, parse_mode: "HTML" }),
      });
      const data = await res.json();
      if (!data.ok) console.error("[telegram]", data.description);
      await new Promise(r => setTimeout(r, 500));
    } catch (e) { console.error("[telegram]", e.message); }
  }
}

async function pollTelegramCommands() {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${telegramOffset}&timeout=5`);
    const data = await res.json();
    if (!data.ok || !data.result) return;
    for (const update of data.result) {
      telegramOffset = update.update_id + 1;
      const text = update.message?.text?.trim().toLowerCase();
      const chatId = update.message?.chat?.id?.toString();
      if (chatId !== TELEGRAM_CHAT_ID) continue;
      if (text === "/reviews") { await sendTelegram("🔍 Fetching reviews..."); await sendAllReviews(); }
      else if (text === "/help") await sendTelegram(`📋 <b>Commands</b>\n/reviews — All past reviews\n/help — This message`);
    }
  } catch (_) {}
}

async function fetchPageHTML(url) {
  // Try ClassPass API endpoint for reviews directly
  // Extract studio slug from URL
  const slug = url.split("/classes/")[1]?.split("?")[0] || "";

  // Try the API first
  const apiUrl = `https://classpass.com/api/v1/venues/${slug}/reviews`;
  const apiRes = await fetch(apiUrl, {
    headers: {
      "User-Agent": "ClassPass/10.0 (iPhone; iOS 16.0; Scale/3.00)",
      "Accept": "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      "Cookie": `ndp_session=${CLASSPASS_COOKIE}`,
      "X-Requested-With": "XMLHttpRequest",
      "Referer": url,
    },
  });

  if (apiRes.ok) {
    const json = await apiRes.json();
    return JSON.stringify(json); // return as string for Claude to parse
  }

  // Fall back to page fetch with full browser headers
  const pageRes = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-SG,en-GB;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive",
      "Cookie": `ndp_session=${CLASSPASS_COOKIE}`,
      "Referer": "https://classpass.com/",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
  return await pageRes.text();
}

async function parseReviewsWithClaude(content, studioName) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const trimmed = content
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .substring(0, 14000);

  const prompt = `Extract all reviews from this ClassPass content for studio "${studioName}". This may be HTML or JSON.

Return a JSON array with:
- id: unique string (stars+text+date combined)
- stars: 1-5 integer (0 if unknown)
- text: review text or ""
- date: date string or ""
- class_name: class name or ""
- instructor: instructor name or ""
- mentions_instructor: true if instructor or text contains "${INSTRUCTOR_NAME}" (case-insensitive)

ONLY return valid JSON array. Return [] if nothing found.

Content:
${trimmed}`;

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

async function sendAllReviews() {
  let grandTotal = 0;
  for (const studio of STUDIOS) {
    let content;
    try { content = await fetchPageHTML(studio.url); }
    catch (e) { await sendTelegram(`❌ ${studio.name}: ${e.message}`); continue; }
    let reviews;
    try { reviews = await parseReviewsWithClaude(content, studio.name); }
    catch (e) { await sendTelegram(`❌ Parse failed for ${studio.name}`); continue; }

    const mine = reviews.filter(r => r.mentions_instructor);
    if (mine.length === 0) { await sendTelegram(`🏢 <b>${studio.name}</b>\n\nNo reviews found for ${INSTRUCTOR_NAME}.`); continue; }
    grandTotal += mine.length;
    let msg = `🏢 <b>${studio.name}</b> — ${mine.length} review(s)\n${"─".repeat(28)}\n\n`;
    for (const r of mine) {
      const stars = "★".repeat(r.stars||0) + "☆".repeat(5-(r.stars||0));
      msg += stars;
      if (r.date) msg += ` · ${r.date}`;
      if (r.class_name) msg += `\n📍 ${r.class_name}`;
      msg += `\n${r.text || "(No written comment)"}\n\n`;
    }
    await sendTelegram(msg);
    await new Promise(r => setTimeout(r, 1000));
  }
  await sendTelegram(`✅ Found <b>${grandTotal}</b> review(s) for <b>${INSTRUCTOR_NAME}</b> across ${STUDIOS.length} studio(s).`);
}

async function checkStudio(studio) {
  console.log(`[check] ${studio.name}`);
  if (!seenReviews[studio.name]) seenReviews[studio.name] = new Set();
  const seen = seenReviews[studio.name];
  let content;
  try { content = await fetchPageHTML(studio.url); }
  catch (e) { console.error(`[check] ${studio.name}: ${e.message}`); return; }
  let reviews;
  try { reviews = await parseReviewsWithClaude(content, studio.name); }
  catch (e) { console.error(`[check] parse error: ${e.message}`); return; }

  console.log(`[check] ${studio.name}: ${reviews.length} review(s)`);
  if (isFirstRun) { reviews.forEach(r => seen.add(r.id)); console.log(`[check] seeded ${reviews.length}`); return; }

  for (const r of reviews) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (!r.mentions_instructor) continue;
    if (RATING_FILTER === "positive" && r.stars < 4) continue;
    if (RATING_FILTER === "negative" && r.stars > 3) continue;
    const stars = "★".repeat(r.stars) + "☆".repeat(5-r.stars);
    const msg = [`🎯 <b>New Review for ${INSTRUCTOR_NAME}!</b>`, `🏢 <b>${studio.name}</b>`, ``,
      `${stars} (${r.stars}/5)`, r.class_name?`📍 ${r.class_name}`:null, r.date?`📅 ${r.date}`:null, ``,
      r.text?`"${r.text}"`:`(No written comment)`].filter(l=>l!==null).join("\n");
    await sendTelegram(msg);
  }
}

async function checkAll() {
  console.log(`\n[${new Date().toISOString()}] Checking...`);
  for (const studio of STUDIOS) { await checkStudio(studio); await new Promise(r=>setTimeout(r,3000)); }
  if (isFirstRun) {
    isFirstRun = false;
    await sendTelegram(`✅ <b>ClassPass Monitor is live!</b>\n\nWatching <b>${STUDIOS.length}</b> studio(s) for <b>${INSTRUCTOR_NAME}</b>\nChecking every <b>${CHECK_INTERVAL_MINS} min</b>\n\nSend /reviews for past reviews!`);
  }
}

function validateConfig() {
  const errors = [];
  if (!TELEGRAM_TOKEN) errors.push("TELEGRAM_TOKEN");
  if (!TELEGRAM_CHAT_ID) errors.push("TELEGRAM_CHAT_ID");
  if (!ANTHROPIC_API_KEY) errors.push("ANTHROPIC_API_KEY");
  if (!CLASSPASS_COOKIE) errors.push("CLASSPASS_COOKIE");
  if (STUDIOS.length === 0) errors.push("STUDIOS");
  if (!INSTRUCTOR_NAME) errors.push("INSTRUCTOR_NAME");
  if (errors.length > 0) { console.error("❌ Missing:", errors.join(", ")); process.exit(1); }
  console.log(`✅ Config OK — watching ${STUDIOS.length} studio(s) for ${INSTRUCTOR_NAME}`);
}

async function main() {
  console.log("🚀 Starting...\n");
  validateConfig();
  await checkAll();
  cron.schedule(`*/${CHECK_INTERVAL_MINS} * * * *`, checkAll);
  setInterval(pollTelegramCommands, 10000);
}

process.on("SIGTERM", () => process.exit(0));
main().catch(e => { console.error("Fatal:", e); process.exit(1); });
