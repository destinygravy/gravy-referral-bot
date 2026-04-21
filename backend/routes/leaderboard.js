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
        let treeDateFilter = '';
        if (period === 'week') {
            dateFilter = "AND re.created_at >= CURRENT_DATE - INTERVAL '7 days'";
            treeDateFilter = "AND rt_desc.created_at >= CURRENT_DATE - INTERVAL '7 days'";
        } else if (period === 'month') {
            dateFilter = "AND re.created_at >= CURRENT_DATE - INTERVAL '30 days'";
            treeDateFilter = "AND rt_desc.created_at >= CURRENT_DATE - INTERVAL '30 days'";
        }

        // Top earners for the period
        let leaderboardQuery;
        if (period === 'all') {
            leaderboardQuery = `SELECT
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
               LIMIT $1`;
        } else {
            // For week/month: sum earnings in the period, and count referrals gained in the period
            leaderboardQuery = `SELECT
                    u.id, u.first_name, u.last_name, u.telegram_username,
                    COALESCE(earnings.period_earned, 0) AS period_earned,
                    COALESCE(referrals.direct_count, 0) AS direct_referrals,
                    COALESCE(referrals.total_count, 0) AS total_network,
                    RANK() OVER (ORDER BY COALESCE(earnings.period_earned, 0) DESC) AS rank
               FROM users u
               INNER JOIN (
                   SELECT earner_id, SUM(amount) AS period_earned
                   FROM referral_earnings
                   WHERE 1=1 ${dateFilter.replace('re.', '')}
                   GROUP BY earner_id
                   HAVING SUM(amount) > 0
               ) earnings ON earnings.earner_id = u.id
               LEFT JOIN (
                   SELECT rt_anc.ancestor_id,
                          COUNT(DISTINCT rt_anc.descendant_id) FILTER (WHERE rt_anc.level = 1) AS direct_count,
                          COUNT(DISTINCT rt_anc.descendant_id) AS total_count
                   FROM referral_tree rt_anc
                   JOIN users rt_desc ON rt_desc.id = rt_anc.descendant_id
                   WHERE 1=1 ${treeDateFilter}
                   GROUP BY rt_anc.ancestor_id
               ) referrals ON referrals.ancestor_id = u.id
               WHERE u.is_onboarded = TRUE
               ORDER BY period_earned DESC
               LIMIT $1`;
        }

        const result = await pool.query(leaderboardQuery, [limit]);

        // Get current user's rank (period-aware)
        const userResult = await pool.query(
            'SELECT id FROM users WHERE telegram_id = $1',
            [telegramId]
        );

        let myRank = null;
        let myEarned = null;
        if (userResult.rows.length > 0) {
            const userId = userResult.rows[0].id;

            if (period === 'all') {
                const myRankResult = await pool.query(
                    `SELECT rank, total_earned FROM (
                        SELECT id, total_earned, RANK() OVER (ORDER BY total_earned DESC) AS rank
                        FROM users WHERE is_onboarded = TRUE AND total_earned > 0
                     ) ranked
                     WHERE id = $1`,
                    [userId]
                );
                myRank = myRankResult.rows[0]?.rank || null;
                myEarned = myRankResult.rows[0]?.total_earned || null;
            } else {
                // Rank by period earnings
                const myRankResult = await pool.query(
                    `SELECT rank, period_earned FROM (
                        SELECT earner_id,
                               SUM(amount) AS period_earned,
                               RANK() OVER (ORDER BY SUM(amount) DESC) AS rank
                        FROM referral_earnings
                        WHERE 1=1 ${dateFilter.replace('re.', '')}
                        GROUP BY earner_id
                        HAVING SUM(amount) > 0
                     ) ranked
                     WHERE earner_id = $1`,
                    [userId]
                );
                myRank = myRankResult.rows[0]?.rank || null;
                myEarned = myRankResult.rows[0]?.period_earned || null;
            }
        }

        return res.json({
            success: true,
            period,
            myRank: myRank ? parseInt(myRank) : null,
            myEarned: myEarned ? parseFloat(myEarned) : null,
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
