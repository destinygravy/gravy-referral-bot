# Gravy Referral Bot — Complete Deployment Guide

Follow these steps in order. Total time: ~30 minutes.

---

## STEP 1: Create Your Telegram Bot (5 min)

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Choose a name: `Gravy Referral Programme`
4. Choose a username: `GravyReferralBot` (must end in "bot")
5. **Copy the bot token** — you'll need this (looks like `7123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`)
6. Send `/setdescription` → select your bot → paste:
   ```
   Earn money by referring friends to Gravy Mobile! 💰 Get ₦200 for every friend who joins, plus passive earnings from their referrals.
   ```
7. Send `/setabouttext` → select your bot → paste:
   ```
   Official Gravy Mobile Referral Programme. Earn ₦200 per referral + passive income from your network.
   ```

**Save your bot token and username — you'll need both.**

---

## STEP 2: Create Hetzner Account & VPS (10 min)

### Create Account
1. Go to **https://accounts.hetzner.com/signUp**
2. Sign up with your email
3. Verify your email
4. Add a payment method (card or PayPal)

### Create VPS
1. Go to **https://console.hetzner.cloud**
2. Click **Create a project** → name it `gravy-referral`
3. Inside the project, click **Add Server**
4. Configure:
   - **Location**: Choose closest to Nigeria (Helsinki or Falkenstein)
   - **Image**: Ubuntu 22.04
   - **Type**: Shared vCPU → **CX22** (€4.15/mo — 2 vCPU, 4GB RAM, 40GB SSD)
   - **Networking**: Leave default (Public IPv4 + IPv6)
   - **SSH Keys**: Add your SSH key (recommended) OR use root password
   - **Name**: `gravy-referral-server`
5. Click **Create & Buy Now**
6. **Copy the server IP address** shown after creation

---

## STEP 3: Connect to Your Server (2 min)

Open your terminal (Command Prompt on Windows, Terminal on Mac/Linux):

```bash
# If you set an SSH key:
ssh root@YOUR_SERVER_IP

# If you set a password:
ssh root@YOUR_SERVER_IP
# (enter your password when prompted)
```

**On Windows?** Use [PuTTY](https://www.putty.org/) or Windows Terminal.

---

## STEP 4: Upload Project Files to Server (3 min)

Open a **new terminal window** (keep the server connection open) and run:

```bash
# From your computer, in the gravy-referral-bot folder:
scp -r ./* root@YOUR_SERVER_IP:/root/gravy-upload/
```

Or if using FileZilla/WinSCP, upload all project files to `/root/gravy-upload/` on the server.

---

## STEP 5: Run Server Setup (5 min)

Back in your **server terminal**:

```bash
# Move files to the right place
mkdir -p /opt/gravy-referral
cp -r /root/gravy-upload/* /opt/gravy-referral/
cd /opt/gravy-referral

# Make scripts executable
chmod +x deploy/*.sh

# Run the automated setup (installs everything)
bash deploy/setup-server.sh
```

Wait for it to complete. This installs Node.js, PostgreSQL, Nginx, PM2, and Cloudflare Tunnel.

---

## STEP 6: Configure Your Environment (3 min)

```bash
cd /opt/gravy-referral

# Create .env from template
cp .env.example .env

# Edit with nano
nano .env
```

Fill in these values:

```
BOT_TOKEN=7123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxx    ← from Step 1
BOT_USERNAME=GravyReferralBot                        ← your bot username (no @)
WEBAPP_URL=https://will-update-later.com             ← we'll update this in Step 8
DATABASE_URL=postgresql://gravy_user:CHANGE_THIS_PASSWORD_123@localhost:5432/gravy_referral
DB_SSL=false
GRAVY_API_BASE_URL=https://api.gravymobile.com       ← your Gravy API URL
GRAVY_API_KEY=your_gravy_api_key                     ← your Gravy API key
GRAVY_DOWNLOAD_URL=https://gravymobile.com/download  ← Gravy app download link
PORT=3000
NODE_ENV=production
MIN_WITHDRAWAL=500
```

⚠️ **IMPORTANT**: Change the database password! Update it in both:
- The `.env` file (in DATABASE_URL)
- PostgreSQL: `sudo -u postgres psql -c "ALTER USER gravy_user PASSWORD 'your_new_password';"`

Save and exit nano: `Ctrl+X` → `Y` → `Enter`

---

## STEP 7: Deploy the App (2 min)

```bash
bash deploy/deploy-app.sh
```

This installs dependencies, creates database tables, and starts the app with PM2.

You should see: **✅ API server is healthy!**

---

## STEP 8: Start Cloudflare Tunnel & Get HTTPS URL (3 min)

```bash
bash deploy/start-tunnel.sh
```

The output will show something like:
```
Your quick Tunnel has been created! Visit it at:
https://something-random-words.trycloudflare.com
```

**Copy that HTTPS URL!** Then open a **new terminal**, SSH into your server again, and:

```bash
# Update WEBAPP_URL in .env
cd /opt/gravy-referral
nano .env
# Change WEBAPP_URL= to your tunnel URL
# e.g., WEBAPP_URL=https://something-random-words.trycloudflare.com

# Restart the app
pm2 restart all
```

---

## STEP 9: Configure Bot's Web App URL (2 min)

1. Go back to **@BotFather** on Telegram
2. Send `/mybots` → select your bot
3. Click **Bot Settings** → **Menu Button** → **Configure menu button**
4. Send the URL: `https://your-tunnel-url.trycloudflare.com`
5. Optionally send `/setmenubutton` and set the text to `🚀 Open App`

---

## STEP 10: Test Everything! (2 min)

1. Open Telegram and find your bot
2. Send `/start`
3. Click **"🚀 Open Gravy Referral App"**
4. The Mini App should load inside Telegram!
5. Try the onboarding flow

---

## Making the Tunnel Permanent

The quick tunnel from Step 8 generates a new URL each time. For a **permanent URL**:

### Option A: Free Cloudflare Tunnel (recommended)
```bash
# Create a free Cloudflare account at https://cloudflare.com
# Then run:
bash deploy/setup-permanent-tunnel.sh
```

### Option B: Buy a cheap domain (~$2/year)
1. Buy a domain from Namecheap, Porkbun, or Cloudflare Registrar
2. Point it to Cloudflare DNS (free plan)
3. Set up the permanent tunnel with your domain

---

## Useful Commands Reference

```bash
# Check app status
pm2 status

# View logs
pm2 logs gravy-api     # API server logs
pm2 logs gravy-bot     # Telegram bot logs
pm2 logs               # All logs

# Restart
pm2 restart all
pm2 restart gravy-api
pm2 restart gravy-bot

# Stop
pm2 stop all

# Monitor (live dashboard)
pm2 monit

# Check database
sudo -u postgres psql gravy_referral -c "SELECT COUNT(*) FROM users;"

# Check Nginx
systemctl status nginx
nginx -t               # Test config

# Check tunnel
systemctl status cloudflared    # If using permanent tunnel
```

---

## Troubleshooting

### "API server may not be ready"
```bash
pm2 logs gravy-api --lines 20
# Check for database connection errors or missing .env values
```

### Bot not responding
```bash
pm2 logs gravy-bot --lines 20
# Common issue: wrong BOT_TOKEN in .env
```

### Mini App not loading in Telegram
- Make sure WEBAPP_URL starts with `https://`
- Make sure the tunnel is running
- Check: `curl https://your-tunnel-url.trycloudflare.com/api/health`

### Database connection error
```bash
# Check PostgreSQL is running
systemctl status postgresql

# Test connection
sudo -u postgres psql -c "SELECT 1;"

# Check your DATABASE_URL in .env matches the user/password you created
```

---

## Monthly Cost Summary

| Item | Cost |
|------|------|
| Hetzner CX22 VPS | €4.15/mo (~₦6,500) |
| Cloudflare Tunnel | FREE |
| Domain (optional) | ~$2/year |
| **Total** | **~₦6,500/month** |
