# Gravy Referral Programme — Telegram Mini App

A multi-level referral system delivered as a Telegram Mini App to drive user acquisition for **Gravy Mobile**.

## Earning Structure

| Level | Relationship | Earning |
|-------|-------------|---------|
| 1 | Direct referral | ₦200 |
| 2 | Referral's referral | ₦50 |
| 3 | 3rd level referral | ₦10 |

**Maximum earning per referral chain: ₦260**

## Architecture

```
gravy-referral-bot/
├── backend/
│   ├── server.js              # Express API server
│   ├── db/
│   │   ├── schema.sql         # PostgreSQL schema
│   │   ├── pool.js            # Database connection pool
│   │   └── init.js            # DB initialization script
│   ├── routes/
│   │   ├── auth.js            # Registration & onboarding verification
│   │   ├── referral.js        # Referral stats, tree, links
│   │   ├── wallet.js          # Wallet balance & transactions
│   │   └── leaderboard.js     # Leaderboard rankings
│   ├── middleware/
│   │   └── telegramAuth.js    # Telegram WebApp authentication
│   └── services/
│       ├── gravyApi.js        # Gravy onboarding API integration
│       └── referralTree.js    # Referral chain & earnings logic
├── bot/
│   └── bot.js                 # Telegram bot (entry point)
├── frontend/
│   └── index.html             # Telegram Mini App (complete SPA)
├── .env.example               # Environment variables template
├── package.json
└── README.md
```

## Setup Guide

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- A Telegram Bot (create via [@BotFather](https://t.me/BotFather))
- HTTPS domain (for Telegram Mini App)
- Gravy Mobile API access (for onboarding verification)

### Step 1: Create Your Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the **bot token** you receive
4. Send `/setmenubutton` → select your bot → send `{"type": "web_app", "text": "Open App", "web_app": {"url": "https://your-domain.com"}}`

### Step 2: Configure Environment

```bash
cp .env.example .env
```

Fill in all values in `.env`:
- `BOT_TOKEN` — from BotFather
- `BOT_USERNAME` — your bot's username (without @)
- `WEBAPP_URL` — where you'll host the frontend (must be HTTPS)
- `DATABASE_URL` — your PostgreSQL connection string
- `GRAVY_API_BASE_URL` and `GRAVY_API_KEY` — from your Gravy team

### Step 3: Set Up Database

```bash
# Create the database
createdb gravy_referral

# Initialize tables
npm run db:init
```

### Step 4: Install & Run

```bash
# Install dependencies
npm install

# Development (runs both API server and bot)
npm run dev

# Production
npm start        # API server
npm run bot      # Telegram bot (run separately)
```

### Step 5: Deploy

For production, you need:

1. **A server/VPS** — DigitalOcean, Railway, Render, or similar
2. **HTTPS domain** — Point your domain to the server, get SSL via Let's Encrypt or Cloudflare
3. **PostgreSQL** — Use a managed database (Supabase, Neon, Railway) or self-hosted
4. **Process manager** — Use PM2 to keep both processes running:

```bash
npm install -g pm2
pm2 start backend/server.js --name gravy-api
pm2 start bot/bot.js --name gravy-bot
pm2 save
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register/login via Telegram |
| POST | `/api/auth/verify-onboarding` | Verify Gravy account |
| GET | `/api/auth/me` | Get user profile |
| GET | `/api/referral/stats` | Referral statistics |
| GET | `/api/referral/tree` | Referral network tree |
| GET | `/api/referral/link` | Get referral link |
| GET | `/api/referral/recent-activity` | Recent earnings |
| GET | `/api/wallet/balance` | Wallet balance |
| GET | `/api/wallet/transactions` | Transaction history |
| POST | `/api/wallet/withdraw` | Request withdrawal |
| GET | `/api/leaderboard` | Top referrers |

## Important Notes

- **Gravy API Integration**: Update `backend/services/gravyApi.js` with your actual Gravy API endpoints
- **Security**: The Telegram auth middleware validates all requests using HMAC-SHA256
- **Anti-fraud**: Each Gravy account can only be linked to one Telegram user
- **Idempotency**: Earnings are distributed only once per onboarding event
