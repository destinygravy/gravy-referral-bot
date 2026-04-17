/**
 * Leaderboard Routes
 *
 * Public and user-specific leaderboard data.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { telegramAuthMiddleware } = require('../middleware/telegramAuth');

/**
 * GET /api/leaderboard
 * Get the top referrers leaderboard
 *
 * Query: ?limit=20&period=all|week|month
 */
router.get('/', telegramAuthMiddleware, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const period = req.query.period || 'all';
    const { id: telegramId } = req.telegramUser;

    try {
        let dateFilter = '';
        if (period === 'week') {
            dateFilter = "AND re.created_at >= CURRENT_DATE - INTERVAL '7 days'";
        } else if (period === 'month') {
            dateFilter = "AND re.created_at >= CURRENT_DATE - INTERVAL '30 days'";
        }

        // Top earners for the period
        const leaderboardQuery = period === 'all'
            ? `SELECT
                    u.id, u.first_name, u.last_name, u.telegram_username,
                    u.total_earned,
                    COUNT(DISTINCT rt.descendant_id) FILTER (WHERE rt.level = 1) AS direct_referrals,
                    COUNT(DISTINCT rt.descendant_id) AS total_network,
                    RANK() OVER (ORDER BY u.total_earned DESC) AS rank
               FROM users u
               LEFT JOIN referral_tree rt ON rt.ancestor_id = u.id
               WHERE u.is_onboarded = TRUE AND u.total_earned > 0
               GROUP BY u.id
               ORDER BY u.total_earned DESC
               LIMIT $1`
            : `SELECT
                    u.id, u.first_name, u.last_name, u.telegram_username,
                    COALESCE(SUM(re.amount), 0) AS period_earned,
                    COUNT(DISTINCT rt.descendant_id) FILTER (WHERE rt.level = 1) AS direct_referrals,
                    COUNT(DISTINCT rt.descendant_id) AS total_network,
                    RANK() OVER (ORDER BY COALESCE(SUM(re.amount), 0) DESC) AS rank
               FROM users u
               LEFT JOIN referral_earnings re ON re.earner_id = u.id ${dateFilter}
               LEFT JOIN referral_tree rt ON rt.ancestor_id = u.id
               WHERE u.is_onboarded = TRUE
               GROUP BY u.id
               HAVING COALESCE(SUM(re.amount), 0) > 0
               ORDER BY period_earned DESC
               LIMIT $1`;

        const result = await pool.query(leaderboardQuery, [limit]);

        // Get current user's rank
        const userResult = await pool.query(
            'SELECT id FROM users WHERE telegram_id = $1',
            [telegramId]
        );

        let myRank = null;
        if (userResult.rows.length > 0) {
            const myRankResult = await pool.query(
                `SELECT rank FROM (
                    SELECT id, RANK() OVER (ORDER BY total_earned DESC) AS rank
                    FROM users WHERE is_onboarded = TRUE AND total_earned > 0
                 ) ranked
                 WHERE id = $1`,
                [userResult.rows[0].id]
            );
            myRank = myRankResult.rows[0]?.rank || null;
        }

        return res.json({
            success: true,
            period,
            myRank: myRank ? parseInt(myRank) : null,
            leaderboard: result.rows.map(row => ({
                rank: parseInt(row.rank),
                firstName: row.first_name,
                lastName: row.last_name,
                username: row.telegram_username,
                earned: parseFloat(row.total_earned || row.period_earned),
                directReferrals: parseInt(row.direct_referrals),
                totalNetwork: parseInt(row.total_network)
            }))
        });

    } catch (error) {
        console.error('[Leaderboard] Error:', error);
        return res.status(500).json({ error: 'Failed to load leaderboard' });
    }
});

module.exports = router;
