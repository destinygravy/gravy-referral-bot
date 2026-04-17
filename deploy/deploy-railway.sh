#!/bin/bash
# ============================================================
# GRAVY REFERRAL BOT — RAILWAY DEPLOYMENT
#
# Prerequisites:
#   1. npm install -g @railway/cli
#   2. railway login
#
# Usage: bash deploy/deploy-railway.sh
# ============================================================

set -e

echo "╔══════════════════════════════════════════╗"
echo "║   GRAVY REFERRAL — RAILWAY DEPLOYMENT    ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ============================================================
# 1. INITIALIZE RAILWAY PROJECT
# ============================================================
echo "🚀 [1/5] Creating Railway project..."
railway init --name gravy-referral

# ============================================================
# 2. ADD POSTGRESQL DATABASE
# ============================================================
echo "🗄️  [2/5] Adding PostgreSQL database..."
echo ""
echo "   ⚠️  MANUAL STEP REQUIRED:"
echo "   1. Go to https://railway.app/dashboard"
echo "   2. Open 'gravy-referral' project"
echo "   3. Click '+ New' → 'Database' → 'Add PostgreSQL'"
echo "   4. Once added, click on the PostgreSQL service"
echo "   5. Go to 'Variables' tab"
echo "   6. Copy the DATABASE_URL value"
echo ""
read -p "   Press ENTER after you've added PostgreSQL..."

# ============================================================
# 3. SET ENVIRONMENT VARIABLES
# ============================================================
echo "🔧 [3/5] Setting environment variables..."

railway variables set BOT_TOKEN="8607932929:AAEDFexVDx_GQJ0N4EtoYy0mldFH-ihDCC0"
railway variables set BOT_USERNAME="GravyReferralBot"
railway variables set GRAVY_API_BASE_URL="https://api.gravymobile.com"
railway variables set GRAVY_API_KEY="UPDATE_WITH_YOUR_GRAVY_API_KEY"
railway variables set GRAVY_DOWNLOAD_URL="https://gravymobile.com/download"
railway variables set PORT="3000"
railway variables set NODE_ENV="production"
railway variables set MIN_WITHDRAWAL="500"
railway variables set DB_SSL="true"

echo "   ✅ Variables set"
echo ""
echo "   ⚠️  NOTE: WEBAPP_URL will be set after first deploy"
echo "   Railway auto-provides DATABASE_URL from PostgreSQL"

# ============================================================
# 4. DEPLOY
# ============================================================
echo "🚢 [4/5] Deploying to Railway..."
railway up --detach

echo ""
echo "   ⏳ Deploying... This takes 1-3 minutes."
echo "   Check status at: https://railway.app/dashboard"
echo ""
read -p "   Press ENTER after deploy shows 'Success' on dashboard..."

# ============================================================
# 5. GET PUBLIC URL & UPDATE WEBAPP_URL
# ============================================================
echo "🌐 [5/5] Generating public URL..."
echo ""
echo "   ⚠️  MANUAL STEP REQUIRED:"
echo "   1. On Railway dashboard, click your app service"
echo "   2. Go to 'Settings' tab"
echo "   3. Under 'Networking' → 'Public Networking'"
echo "   4. Click 'Generate Domain'"
echo "   5. Copy the URL (looks like: gravy-referral-production.up.railway.app)"
echo ""
read -p "   Paste your Railway URL here: " RAILWAY_URL

# Set the WEBAPP_URL
railway variables set WEBAPP_URL="https://${RAILWAY_URL}"

echo ""
echo "   ✅ WEBAPP_URL set to: https://${RAILWAY_URL}"
echo "   Redeploying with updated URL..."
railway up --detach

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║              ✅ DEPLOYMENT COMPLETE!                     ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║                                                          ║"
echo "║  Your app: https://${RAILWAY_URL}                        ║"
echo "║                                                          ║"
echo "║  FINAL STEP — Configure your Telegram Bot:               ║"
echo "║  1. Open @BotFather on Telegram                          ║"
echo "║  2. Send: /mybots → select your bot                      ║"
echo "║  3. Bot Settings → Menu Button → Configure               ║"
echo "║  4. Send: https://${RAILWAY_URL}                         ║"
echo "║                                                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
