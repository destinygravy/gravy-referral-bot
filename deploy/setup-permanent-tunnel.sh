#!/bin/bash
# ============================================================
# PERMANENT CLOUDFLARE TUNNEL (as systemd service)
#
# This sets up the tunnel to run permanently in the background,
# auto-start on boot, and maintain a consistent URL.
#
# Run this AFTER you've tested with start-tunnel.sh
# ============================================================

set -e

echo "🔒 Setting up permanent Cloudflare Tunnel..."
echo ""

# Step 1: Login to Cloudflare (opens browser or gives you a URL)
echo "[1/4] Authenticating with Cloudflare..."
echo "   You'll need a FREE Cloudflare account."
echo "   A browser window or URL will open — log in there."
echo ""
cloudflared tunnel login

# Step 2: Create named tunnel
echo ""
echo "[2/4] Creating named tunnel..."
TUNNEL_NAME="gravy-referral"
cloudflared tunnel create "$TUNNEL_NAME"

# Get tunnel UUID
TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
echo "   Tunnel ID: $TUNNEL_ID"

# Step 3: Create config
echo "[3/4] Creating tunnel configuration..."
mkdir -p /etc/cloudflared

cat > /etc/cloudflared/config.yml <<EOF
tunnel: $TUNNEL_ID
credentials-file: /root/.cloudflared/${TUNNEL_ID}.json

ingress:
  - hostname: gravy-referral.yourdomain.com
    service: http://localhost:80
  - service: http_status:404
EOF

echo "   ✅ Config written to /etc/cloudflared/config.yml"
echo ""
echo "   ⚠️  IMPORTANT: Edit /etc/cloudflared/config.yml"
echo "   Replace 'gravy-referral.yourdomain.com' with your actual domain"
echo "   Or if using Cloudflare's free domain, check the tunnel URL"

# Step 4: Install as system service
echo ""
echo "[4/4] Installing as system service..."
cloudflared service install
systemctl enable cloudflared
systemctl start cloudflared

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   ✅ PERMANENT TUNNEL CONFIGURED!         ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "The tunnel is now running as a background service."
echo "It will auto-start on reboot."
echo ""
echo "Commands:"
echo "  systemctl status cloudflared   — Check tunnel status"
echo "  cloudflared tunnel list        — List tunnels"
echo "  journalctl -u cloudflared      — View tunnel logs"
echo ""
