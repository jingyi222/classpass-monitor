# ClassPass Review Monitor 🎯

Monitors your ClassPass reviews across multiple studios and sends a Telegram message the moment a new review appears.

---

## Setup

### 1. Get your Telegram credentials

1. Open Telegram → search **@BotFather** → send `/newbot`
2. Follow prompts → copy the **Bot Token**
3. Send any message to your new bot (e.g. "hello")
4. Visit `https://api.telegram.org/botYOUR_TOKEN/getUpdates` → find your **Chat ID**

### 2. Get your Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an API key (the monitor uses the cheapest Haiku model, costs pennies per month)

### 3. Deploy to Railway (free tier)

1. Go to [railway.app](https://railway.app) → sign up with GitHub
2. Click **New Project** → **Deploy from GitHub repo** → upload/push this folder
3. Go to your service → **Variables** tab → add all environment variables below

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_TOKEN` | ✅ | Your Telegram bot token from BotFather |
| `TELEGRAM_CHAT_ID` | ✅ | Your Telegram chat ID |
| `ANTHROPIC_API_KEY` | ✅ | Your Anthropic API key |
| `INSTRUCTOR_NAME` | ✅ | Your name as shown on ClassPass (e.g. `Jing Yi`) |
| `STUDIOS` | ✅ | Comma-separated list of studios (see format below) |
| `CHECK_INTERVAL_MINS` | ❌ | How often to check in minutes (default: `30`) |
| `RATING_FILTER` | ❌ | `all`, `positive` (4–5★), or `negative` (1–3★). Default: `all` |

### STUDIOS format

Each studio is `Studio Name|URL`, separated by commas:

```
STUDIOS=Pure Yoga Orchard|https://classpass.com/classes/pure-yoga-orchard,Club Pilates Tanjong Pagar|https://classpass.com/classes/club-pilates-tanjong-pagar,Breathe Pilates|https://classpass.com/classes/breathe-pilates
```

---

## What happens

- On first start: seeds all existing reviews (no notifications for old reviews)
- Sends a Telegram confirmation message when live
- Every X minutes: checks each studio page for new reviews
- Sends a Telegram notification per new review showing: studio name, star rating, class name, date, review text, and whether it mentions you by name

---

## Example Telegram notification

```
🎯 New ClassPass Review!
🏢 Pure Yoga Orchard

★★★★★ (5/5)
📍 Mat Pilates - Intermediate
📅 March 2026

"Amazing class, the instructor really pushed us in the best way!"

👤 Mentions you by name!
```
