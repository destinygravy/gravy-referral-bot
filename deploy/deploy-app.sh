#!/bin/bash
# ============================================================
# GRAVY REFERRAL BOT — APP DEPLOYMENT
# Run AFTER setup-server.sh and after copying project files
#
# Usage: bash /opt/gravy-referral/deploy/deploy-app.sh
# ============================================================

set -e

APP_DIR="/opt/gravy-referral"
cd "$APP_DIR"

echo "🚀 Deploying Gravy Referral Bot..."
echo ""

# ============================================================
# 1. CHECK .ENV FILE
# ============================================================
if [ ! -f "$APP_DIR/.env" ]; then
    echo "⚠️  No .env file found!"
    echo "   Copying .env.example to .env..."
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    echo ""
    echo "   ❌ IMPORTANT: Edit .env with your actual values before continuing!"
    echo "   Run: nano /opt/gravy-referral/.env"
    echo ""
    echo "   Required values:"
    echo "   - BOT_TOKEN (from @BotFather)"
    echo "   - BOT_USERNAME (your bot's username)"
    echo "   - WEBAPP_URL (will be set after tunnel starts)"
    echo "   - GRAVY_API_BASE_URL"
    echo "   - GRAVY_API_KEY"
    echo ""
    exit 1
fi

echo "✅ .env file found"

# ============================================================
# 2. INSTALL DEPENDENCIES
# ============================================================
echo "📦 Installing Node.js dependencies..."
npm install --production
echo "   ✅ Dependencies installed"

# ============================================================
# 3. INITIALIZE DATABASE
# ============================================================
echo "🗄️  Initializing database..."

# Update DATABASE_URL in .env if using local PostgreSQL
# Default: postgresql://gravy_user:CHANGE_THIS_PASSWORD_123@localhost:5432/gravy_referral
npm run db:init
echo "   ✅ Database tables created"

# ============================================================
# 4. START WITH PM2
# ============================================================
echo "🔄 Starting application with PM2..."

# Stop any existing processes
pm2 delete gravy-api gravy-bot 2>/dev/null || true

# Start API server
pm2 start backend/server.js \
    --name gravy-api \
    --cwd "$APP_DIR" \
    --max-memory-restart 300M \
    --env production

# Start Telegram bot
pm2 start bot/bot.js \
    --name gravy-bot \
    --cwd "$APP_DIR" \
    --max-memory-restart 200M \
    --env production

# Save PM2 process list (survives reboot)
pm2 save

# Set PM2 to start on boot
pm2 startup systemd -u root --hp /root

echo "   ✅ Application running"

# ============================================================
# 5. VERIFY
# ============================================================
echo ""
echo "🔍 Verifying deployment..."
sleep 2

# Check if API is responding
if curl -s http://localhost:3000/api/health | grep -q "ok"; then
    echo "   ✅ API server is healthy!"
else
    echo "   ⚠️  API server may not be ready yet. Check: pm2 logs gravy-api"
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       ✅ APP DEPLOYED SUCCESSFULLY!       ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Useful commands:"
echo "  pm2 status          — Check process status"
echo "  pm2 logs gravy-api  — View API server logs"
echo "  pm2 logs gravy-bot  — View bot logs"
echo "  pm2 restart all     — Restart everything"
echo ""
echo "Next: Run 'bash /opt/gravy-referral/deploy/start-tunnel.sh'"
echo "      to get your free HTTPS URL for Telegram"
echo ""
