#!/bin/bash
# ============================================================
# GRAVY REFERRAL BOT — AUTOMATED SERVER SETUP
# Run this on a fresh Hetzner Ubuntu 22.04 VPS
#
# Usage: bash setup-server.sh
# ============================================================

set -e  # Exit on any error

echo "╔══════════════════════════════════════════╗"
echo "║   GRAVY REFERRAL BOT — SERVER SETUP      ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ============================================================
# 1. SYSTEM UPDATE & ESSENTIALS
# ============================================================
echo "📦 [1/8] Updating system packages..."
apt update && apt upgrade -y
apt install -y curl git ufw nginx certbot python3-certbot-nginx

# ============================================================
# 2. INSTALL NODE.JS 20 LTS
# ============================================================
echo "📦 [2/8] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
echo "   Node: $(node -v)"
echo "   NPM: $(npm -v)"

# ============================================================
# 3. INSTALL POSTGRESQL 15
# ============================================================
echo "📦 [3/8] Installing PostgreSQL 15..."
apt install -y postgresql postgresql-contrib

# Start PostgreSQL
systemctl start postgresql
systemctl enable postgresql

# Create database and user
echo "   Creating database..."
sudo -u postgres psql <<EOSQL
CREATE USER gravy_user WITH PASSWORD 'GravySecure2026!';
CREATE DATABASE gravy_referral OWNER gravy_user;
GRANT ALL PRIVILEGES ON DATABASE gravy_referral TO gravy_user;
\c gravy_referral
GRANT ALL ON SCHEMA public TO gravy_user;
EOSQL

echo "   ✅ Database created: gravy_referral"

# ============================================================
# 4. INSTALL PM2 (Process Manager)
# ============================================================
echo "📦 [4/8] Installing PM2..."
npm install -g pm2

# ============================================================
# 5. INSTALL CLOUDFLARED (Free HTTPS Tunnel)
# ============================================================
echo "📦 [5/8] Installing Cloudflare Tunnel..."
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i cloudflared.deb
rm cloudflared.deb
echo "   ✅ Cloudflared installed: $(cloudflared --version)"

# ============================================================
# 6. CREATE APP DIRECTORY & CLONE/COPY PROJECT
# ============================================================
echo "📦 [6/8] Setting up application directory..."
mkdir -p /opt/gravy-referral
echo "   ✅ Directory created: /opt/gravy-referral"
echo ""
echo "   ⚠️  NEXT STEP: Copy your project files to /opt/gravy-referral/"
echo "   You can use: scp -r ./gravy-referral-bot/* root@YOUR_SERVER_IP:/opt/gravy-referral/"
echo ""

# ============================================================
# 7. CONFIGURE FIREWALL
# ============================================================
echo "📦 [7/8] Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
echo "   ✅ Firewall configured (SSH + HTTP/HTTPS)"

# ============================================================
# 8. CONFIGURE NGINX
# ============================================================
echo "📦 [8/8] Configuring Nginx..."
cp /opt/gravy-referral/deploy/nginx.conf /etc/nginx/sites-available/gravy-referral
ln -sf /etc/nginx/sites-available/gravy-referral /etc/nginx/sites-enabled/gravy-referral
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx
echo "   ✅ Nginx configured"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║        ✅ SERVER SETUP COMPLETE!          ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Copy your project files to /opt/gravy-referral/"
echo "  2. Run: bash /opt/gravy-referral/deploy/deploy-app.sh"
echo "  3. Run: bash /opt/gravy-referral/deploy/start-tunnel.sh"
echo ""
