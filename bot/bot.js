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

    console.log(`[Bot] /start from ${ctx.from.id} (${firstName}), payload: ${payload || 'none'}, webAppUrl: ${webAppUrl}`);

    const firstName = ctx.from.first_name || 'there';

    await ctx.replyWithPhoto(
        { url: 'https://via.placeholder.com/800x400/6C3CE1/FFFFFF?text=GRAVY+REFERRAL+PROGRAMME' },
        {
            caption: `🎉 *Welcome to Gravy Referral Programme, ${firstName}!*\n\n` +
                `Earn real money by inviting friends to Gravy Mobile\\!\n\n` +
                `💰 *How it works:*\n` +
                `• Refer a friend → Earn *₦200* when they sign up\n` +
                `• Your friend refers someone → You earn *₦50*\n` +
                `• That person refers someone → You still earn *₦10*\\!\n\n` +
                `📱 Tap the button below to get started\\!`,
            parse_mode: 'MarkdownV2',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('🚀 Open Gravy Referral App', webAppUrl)],
                [Markup.button.url('📱 Download Gravy Mobile', process.env.GRAVY_DOWNLOAD_URL || 'https://gravymobile.com')]
            ])
        }
    ).catch(async () => {
        // Fallback without image if image fails
        await ctx.reply(
            `🎉 Welcome to Gravy Referral Programme, ${firstName}!\n\n` +
            `Earn real money by inviting friends to Gravy Mobile!\n\n` +
            `💰 How it works:\n` +
            `• Refer a friend → Earn ₦200 when they sign up\n` +
            `• Your friend refers someone → You earn ₦50\n` +
            `• That person refers someone → You still earn ₦10!\n\n` +
            `📱 Tap the button below to get started!`,
            Markup.inlineKeyboard([
                [Markup.button.webApp('🚀 Open Gravy Referral App', webAppUrl)],
                [Markup.button.url('📱 Download Gravy Mobile', process.env.GRAVY_DOWNLOAD_URL || 'https://gravymobile.com')]
            ])
        );
    });
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
