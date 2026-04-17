/**
 * Referral Routes
 *
 * Handles referral tree, stats, and referral link generation.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { telegramAuthMiddleware } = require('../middleware/telegramAuth');
const { getUserReferralTree, getUserReferralStats } = require('../services/referralTree');

/**
 * GET /api/referral/stats
 * Get current user's referral statistics
 */
router.get('/stats', telegramAuthMiddleware, async (req, res) => {
    const { id: telegramId } = req.telegramUser;

    try {
        const userResult = await pool.query(
            'SELECT id, is_onboarded FROM users WHERE telegram_id = $1',
            [telegramId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = userResult.rows[0];
        const stats = await getUserReferralStats(user.id);

        return res.json({
            success: true,
            stats: {
                level1: {
                    count: parseInt(stats.referrals.level1_count),
                    earnings: parseFloat(stats.earnings.level1_earnings)
                },
                level2: {
                    count: parseInt(stats.referrals.level2_count),
                    earnings: parseFloat(stats.earnings.level2_earnings)
                },
                level3: {
                    count: parseInt(stats.referrals.level3_count),
                    earnings: parseFloat(stats.earnings.level3_earnings)
                },
                totalNetwork: parseInt(stats.referrals.total_network),
                totalEarnings: parseFloat(stats.earnings.total_earnings)
            }
        });

    } catch (error) {
        console.error('[Referral] Stats error:', error);
        return res.status(500).json({ error: 'Failed to load referral stats' });
    }
});

/**
 * GET /api/referral/tree
 * Get the user's referral tree for visual display
 */
router.get('/tree', telegramAuthMiddleware, async (req, res) => {
    const { id: telegramId } = req.telegramUser;

    try {
        const userResult = await pool.query(
            'SELECT id FROM users WHERE telegram_id = $1',
            [telegramId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const tree = await getUserReferralTree(userResult.rows[0].id);

        return res.json({
            success: true,
            tree
        });

    } catch (error) {
        console.error('[Referral] Tree error:', error);
        return res.status(500).json({ error: 'Failed to load referral tree' });
    }
});

/**
 * GET /api/referral/link
 * Generate the user's referral link
 */
router.get('/link', telegramAuthMiddleware, async (req, res) => {
    const { id: telegramId } = req.telegramUser;

    try {
        const userResult = await pool.query(
            'SELECT referral_code, is_onboarded FROM users WHERE telegram_id = $1',
            [telegramId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = userResult.rows[0];

        if (!user.is_onboarded) {
            return res.status(403).json({
                error: 'You must complete Gravy onboarding before you can refer others.'
            });
        }

        const botUsername = process.env.BOT_USERNAME;
        const googlePlayUrl = 'https://play.google.com/store/apps/details?id=com.gravystream.gravy';
        const appleStoreUrl = 'https://apps.apple.com/app/gravy-mobile/id6753959895';
        const referralLink = `https://t.me/${botUsername}?start=ref_${user.referral_code}`;

        return res.json({
            success: true,
            referralCode: user.referral_code,
            referralLink,
            googlePlayUrl,
            appleStoreUrl,
            shareText: `🚀 Join Gravy Mobile and start earning!\n\n📲 Download Gravy:\n🤖 Android: ${googlePlayUrl}\n🍎 iPhone: ${appleStoreUrl}\n\n🎁 Then open my referral link to claim your bonus:\n${referralLink}`
        });

    } catch (error) {
        console.error('[Referral] Link error:', error);
        return res.status(500).json({ error: 'Failed to generate referral link' });
    }
});

/**
 * GET /api/referral/recent-activity
 * Get recent referral activity (earnings log)
 */
router.get('/recent-activity', telegramAuthMiddleware, async (req, res) => {
    const { id: telegramId } = req.telegramUser;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    try {
        const userResult = await pool.query(
            'SELECT id FROM users WHERE telegram_id = $1',
            [telegramId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const userId = userResult.rows[0].id;

        const activity = await pool.query(
            `SELECT
                re.amount,
                re.level,
                re.created_at,
                u.first_name,
                u.telegram_username
             FROM referral_earnings re
             JOIN users u ON u.id = re.source_user_id
             WHERE re.earner_id = $1
             ORDER BY re.created_at DESC
             LIMIT $2`,
            [userId, limit]
        );

        return res.json({
            success: true,
            activity: activity.rows.map(row => ({
                amount: parseFloat(row.amount),
                level: row.level,
                from: row.first_name || row.telegram_username || 'Anonymous',
                date: row.created_at
            }))
        });

    } catch (error) {
        console.error('[Referral] Activity error:', error);
        return res.status(500).json({ error: 'Failed to load activity' });
    }
});

module.exports = router;
