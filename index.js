const fetch = require("node-fetch");
const cron = require("node-cron");
const cheerio = require("cheerio");

// ─── CONFIG (set via environment variables) ───────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CHECK_INTERVAL_MINS = parseInt(process.env.CHECK_INTERVAL_MINS || "30");
const INSTRUCTOR_NAME = process.env.INSTRUCTOR_NAME || "";
const RATING_FILTER = process.env.RATING_FILTER || "all"; // all | positive | negative

// Studios: comma-separated list of "Studio Name|URL" pairs
// e.g. STUDIOS="Pure Yoga|https://classpass.com/...,Etc Studio|https://classpass.com/..."
const STUDIOS = (process.env.STUDIOS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [name, ...rest] = s.split("|");
    return { name: name.trim(), url: rest.join("|").trim() };
  });

// ─── STATE ────────────────────────────────────────────────────────────────────
// In-memory store: studioName -> Set of seen review IDs
const seenReviews = {};
let isFirstRun = true;

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("[telegram] No credentials set, skipping notification.");
    return;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
        }),
      }
    );
    const data = await res.json();
    if (!data.ok) console.error("[telegram] Error:", data.description);
    else console.log("[telegram] Message sent.");
  } catch (e) {
    console.error("[telegram] Failed to send:", e.message);
  }
}

// ─── FETCH PAGE ───────────────────────────────────────────────────────────────
async function fetchPageHTML(url) {
  const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
  const res = await fetch(proxyUrl, { timeout: 15000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} from proxy`);
  const data = await res.json();
  if (!data.contents) throw new Error("Empty page response");
  return data.contents;
}

// ─── PARSE REVIEWS VIA CLAUDE ─────────────────────────────────────────────────
async function parseReviewsWithClaude(html, studioName) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  // Pre-clean HTML with cheerio to reduce token usage
  const $ = cheerio.load(html);
  // Remove scripts, styles, nav, footer to keep only content
  $("script, style, nav, footer, head, noscript, svg, img").remove();
  const trimmedHtml = $.html().substring(0, 14000);

  const prompt = `You are a web scraping assistant. Extract all reviews from this ClassPass page for the studio "${studioName}".

For each review, return a JSON array of objects:
- id: unique hash string (combine stars+text+date, no spaces)
- stars: integer 1-5 (if not found, use 0)
- text: review text, empty string if none
- date: date string if visible, empty string if not
- class_name: class name if shown, empty string if not
- mentions_instructor: true if text mentions "${INSTRUCTOR_NAME}" or "instructor" or "teacher"

Return ONLY a valid JSON array, no markdown, no explanation. If no reviews found, return [].

HTML:
${trimmedHtml}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const raw = data.content?.[0]?.text || "[]";
  const clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── CHECK ONE STUDIO ─────────────────────────────────────────────────────────
async function checkStudio(studio) {
  console.log(`[check] Checking studio: ${studio.name}`);

  if (!seenReviews[studio.name]) seenReviews[studio.name] = new Set();
  const seen = seenReviews[studio.name];

  let html;
  try {
    html = await fetchPageHTML(studio.url);
  } catch (e) {
    console.error(`[check] Failed to fetch ${studio.name}: ${e.message}`);
    return;
  }

  let reviews;
  try {
    reviews = await parseReviewsWithClaude(html, studio.name);
  } catch (e) {
    console.error(`[check] Failed to parse reviews for ${studio.name}: ${e.message}`);
    return;
  }

  console.log(`[check] ${studio.name}: ${reviews.length} review(s) found on page`);

  // On first run, just seed the seen set without notifying
  if (isFirstRun) {
    reviews.forEach((r) => seen.add(r.id));
    console.log(`[check] First run — seeded ${reviews.length} existing review(s) for ${studio.name}`);
    return;
  }

  let newCount = 0;
  for (const review of reviews) {
    if (seen.has(review.id)) continue;
    seen.add(review.id);

    // Apply rating filter
    if (RATING_FILTER === "positive" && review.stars < 4) continue;
    if (RATING_FILTER === "negative" && review.stars > 3) continue;

    newCount++;
    const stars = "★".repeat(review.stars) + "☆".repeat(5 - review.stars);
    const msg = [
      `🎯 <b>New ClassPass Review!</b>`,
      `🏢 <b>${studio.name}</b>`,
      ``,
      `${stars} (${review.stars}/5)`,
      review.class_name ? `📍 ${review.class_name}` : null,
      review.date ? `📅 ${review.date}` : null,
      ``,
      review.text ? `"${review.text}"` : `(No written comment)`,
      review.mentions_instructor ? `\n👤 Mentions you by name!` : null,
    ]
      .filter((l) => l !== null)
      .join("\n");

    console.log(`[notify] New review for ${studio.name}: ${review.stars}★`);
    await sendTelegram(msg);
  }

  if (newCount === 0) {
    console.log(`[check] No new reviews for ${studio.name}`);
  } else {
    console.log(`[check] ${newCount} new review(s) found for ${studio.name}!`);
  }
}

// ─── CHECK ALL STUDIOS ────────────────────────────────────────────────────────
async function checkAll() {
  console.log(`\n[${new Date().toISOString()}] Running check across ${STUDIOS.length} studio(s)...`);
  for (const studio of STUDIOS) {
    await checkStudio(studio);
    // Small delay between studios to avoid rate limiting
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (isFirstRun) {
    isFirstRun = false;
    console.log("[init] First run complete. Now watching for NEW reviews only.");
    await sendTelegram(
      `✅ <b>ClassPass Monitor is live!</b>\n\nWatching <b>${STUDIOS.length}</b> studio(s) for new reviews mentioning <b>${INSTRUCTOR_NAME}</b>.\n\nChecking every <b>${CHECK_INTERVAL_MINS} minutes</b>.`
    );
  }
}

// ─── STARTUP ──────────────────────────────────────────────────────────────────
function validateConfig() {
  const errors = [];
  if (!TELEGRAM_TOKEN) errors.push("TELEGRAM_TOKEN");
  if (!TELEGRAM_CHAT_ID) errors.push("TELEGRAM_CHAT_ID");
  if (!ANTHROPIC_API_KEY) errors.push("ANTHROPIC_API_KEY");
  if (STUDIOS.length === 0) errors.push("STUDIOS");
  if (!INSTRUCTOR_NAME) errors.push("INSTRUCTOR_NAME");

  if (errors.length > 0) {
    console.error("❌ Missing required environment variables:", errors.join(", "));
    console.error("See README.md for setup instructions.");
    process.exit(1);
  }

  console.log("✅ Config loaded:");
  console.log(`   Instructor: ${INSTRUCTOR_NAME}`);
  console.log(`   Studios (${STUDIOS.length}):`);
  STUDIOS.forEach((s) => console.log(`     - ${s.name}: ${s.url}`));
  console.log(`   Check interval: every ${CHECK_INTERVAL_MINS} minutes`);
  console.log(`   Rating filter: ${RATING_FILTER}`);
}

async function main() {
  console.log("🚀 ClassPass Review Monitor starting...\n");
  validateConfig();

  // Run immediately on start
  await checkAll();

  // Schedule recurring checks
  const cronExpr = `*/${CHECK_INTERVAL_MINS} * * * *`;
  cron.schedule(cronExpr, checkAll);
  console.log(`\n⏰ Scheduled to check every ${CHECK_INTERVAL_MINS} minutes.`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
