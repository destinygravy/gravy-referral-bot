/**
 * Telegram WebApp Authentication Middleware
 *
 * Validates the initData sent by Telegram Mini Apps to ensure
 * requests are genuinely coming from Telegram.
 *
 * See: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */

const crypto = require('crypto');

function validateTelegramWebAppData(initData, botToken) {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');

    if (!hash) return null;

    // Remove hash from params and sort alphabetically
    urlParams.delete('hash');
    const dataCheckString = Array.from(urlParams.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

    // Create HMAC-SHA256 using bot token
    const secretKey = crypto
        .createHmac('sha256', 'WebAppData')
        .update(botToken)
        .digest();

    const calculatedHash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

    if (calculatedHash !== hash) return null;

    // Check if data is not too old (allow 1 hour)
    const authDate = parseInt(urlParams.get('auth_date'), 10);
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > 3600) return null;

    // Parse and return user data
    const userStr = urlParams.get('user');
    if (!userStr) return null;

    try {
        return JSON.parse(userStr);
    } catch {
        return null;
    }
}

/**
 * Express middleware that validates Telegram auth
 * and attaches telegramUser to req
 */
function telegramAuthMiddleware(req, res, next) {
    const initData = req.headers['x-telegram-init-data'];

    if (!initData) {
        return res.status(401).json({
            error: 'Missing Telegram authentication data'
        });
    }

    const telegramUser = validateTelegramWebAppData(
        initData,
        process.env.BOT_TOKEN
    );

    if (!telegramUser) {
        return res.status(401).json({
            error: 'Invalid or expired Telegram authentication'
        });
    }

    req.telegramUser = telegramUser;
    next();
}

module.exports = { telegramAuthMiddleware, validateTelegramWebAppData };
