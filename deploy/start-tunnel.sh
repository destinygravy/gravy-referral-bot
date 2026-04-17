#!/bin/bash
# ============================================================
# CLOUDFLARE TUNNEL — Free HTTPS for Telegram Mini App
#
# This creates a FREE public HTTPS URL that tunnels to your
# local server. No domain purchase needed!
#
# The URL will look like: https://random-words.trycloudflare.com
#
# Usage: bash start-tunnel.sh
# ============================================================

echo "🌐 Starting Cloudflare Tunnel..."
echo ""
echo "This will give you a FREE HTTPS URL for your Telegram Mini App."
echo "The URL will look like: https://something-random.trycloudflare.com"
echo ""
echo "⚠️  IMPORTANT: After the tunnel starts, you MUST:"
echo "   1. Copy the HTTPS URL shown below"
echo "   2. Update WEBAPP_URL in /opt/gravy-referral/.env"
echo "   3. Update your bot's Web App URL via @BotFather"
echo "   4. Restart the app: pm2 restart all"
echo ""
echo "Starting tunnel to localhost:80 (Nginx)..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

cloudflared tunnel --url http://localhost:80

# NOTE: The free "quick tunnel" generates a new URL each time.
# For a PERMANENT free URL, set up a named tunnel:
#
#   cloudflared tunnel login
#   cloudflared tunnel create gravy-referral
#   cloudflared tunnel route dns gravy-referral gravy.yourdomain.com
#   cloudflared tunnel run gravy-referral
#
# Or for a permanent free URL without a domain, run the tunnel
# as a systemd service so it auto-starts and keeps the same URL.
