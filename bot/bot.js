/**
 * Gravy Referral Telegram Bot
 *
 * This bot serves as the entry point for the referral programme.
 * It handles /start commands (with referral codes) and launches
 * the Mini App for users.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Telegraf, Markup } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);
const WEBAPP_URL = process.env.WEBAPP_URL;
const GOOGLE_PLAY_URL = 'https://play.google.com/store/apps/details?id=com.gravystream.gravy';
const APPLE_STORE_URL = 'https://apps.apple.com/app/gravy-mobile/id6753959895';

// ============================================================
// /start command — Entry point for new and returning users
// ============================================================
bot.start(async (ctx) => {
    const payload = ctx.startPayload;  // e.g., "ref_GRV3A8K2"
    let referralCode = null;

    if (payload && payload.startsWith('ref_')) {
        referralCode = payload.replace('ref_', '');
    }

    // Pass referral code as URL query param — Telegram WebApp buttons preserve these
    const webAppUrl = referralCode
        ? `${WEBAPP_URL}?ref=${referralCode}`
        : WEBAPP_URL;

    const firstName = ctx.from.first_name || 'there';

    console.log(`[Bot] /start from ${ctx.from.id} (${firstName}), payload: ${payload || 'none'}, webAppUrl: ${webAppUrl}`);

    await ctx.reply(
        `🎉 Welcome to Gravy Referral Programme, ${firstName}!\n\n` +
        `Earn real money by inviting friends to Gravy Mobile!\n\n` +
        `💰 How it works:\n` +
        `• Refer a friend → Earn ₦200 when they sign up\n` +
        `• Your friend refers someone → You earn ₦50\n` +
        `• That person refers someone → You still earn ₦10!\n\n` +
        `📲 Step 1: Download Gravy App if you haven't already\n` +
        `🔗 Step 2: Tap "Open Gravy Referral App" below to register & verify\n` +
        `🎁 Step 3: Share your own referral link and start earning!`,
        Markup.inlineKeyboard([
            [Markup.button.webApp('🚀 Open Gravy Referral App', webAppUrl)],
            [Markup.button.url('📥 Download for Android', GOOGLE_PLAY_URL)],
            [Markup.button.url('📥 Download for iPhone', APPLE_STORE_URL)]
        ])
    );
});

// ============================================================
// /help command
// ============================================================
bot.help(async (ctx) => {
    await ctx.reply(
        `ℹ️ *Gravy Referral Programme Help*\n\n` +
        `*Commands:*\n` +
        `/start \\- Open the referral app\n` +
        `/help \\- Show this help message\n` +
        `/stats \\- View your referral stats\n` +
        `/link \\- Get your referral link\n\n` +
        `*How to earn:*\n` +
        `1\\. Complete your Gravy onboarding\n` +
        `2\\. Share your referral link\n` +
        `3\\. Earn ₦200 for each friend who signs up\n` +
        `4\\. Earn ₦50 when your friends refer others\n` +
        `5\\. Earn ₦10 from 3rd\\-level referrals\\!`,
        { parse_mode: 'MarkdownV2' }
    );
});

// ============================================================
// /stats command — Quick stats without opening Mini App
// ============================================================
bot.command('stats', async (ctx) => {
    await ctx.reply(
        '📊 Tap below to view your full referral dashboard:',
        Markup.inlineKeyboard([
            [Markup.button.webApp('📊 View Dashboard', `${WEBAPP_URL}?tab=stats`)]
        ])
    );
});

// ============================================================
// /link command — Get referral link
// ============================================================
bot.command('link', async (ctx) => {
    await ctx.reply(
        '🔗 Tap below to get your referral link and share it:',
        Markup.inlineKeyboard([
            [Markup.button.webApp('🔗 Get Referral Link', `${WEBAPP_URL}?tab=refer`)]
        ])
    );
});

// ============================================================
// Handle any text messages
// ============================================================
bot.on('text', async (ctx) => {
    await ctx.reply(
        'Tap the button below to open the Gravy Referral App! 🚀',
        Markup.inlineKeyboard([
            [Markup.button.webApp('🚀 Open Gravy Referral App', WEBAPP_URL)]
        ])
    );
});

// ============================================================
// Error handling
// ============================================================
bot.catch((err, ctx) => {
    console.error(`Bot error for ${ctx.updateType}:`, err);
});

// ============================================================
// Launch bot
// ============================================================
bot.launch().then(() => {
    console.log('🤖 Gravy Referral Bot is running!');
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
