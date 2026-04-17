/**
 * Referral Tree Service
 *
 * Manages the multi-level referral chain.
 * Handles earning distribution across 3 levels:
 *   Level 1 (Direct):   ₦200
 *   Level 2 (Indirect): ₦50
 *   Level 3 (Deep):     ₦10
 */

const pool = require('../db/pool');

// Earning amounts per level (in Naira)
const EARNINGS_PER_LEVEL = {
    1: 200.00,  // Direct referral
    2: 50.00,   // Referral's referral
    3: 10.00    // 3rd level deep
};

/**
 * Generate a unique referral code
 */
function generateReferralCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusing chars (0,O,1,I)
    let code = 'GRV';
    for (let i = 0; i < 5; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

/**
 * Register referral chain when a new user joins via a referral link.
 * This creates entries in referral_tree for up to 3 ancestors.
 *
 * @param {string} newUserId - The newly registered user's ID
 * @param {string} referrerId - The direct referrer's user ID
 */
async function registerReferralChain(newUserId, referrerId) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Get the referrer's ancestors (up to 2 levels up)
        const ancestorsResult = await client.query(
            `SELECT ancestor_id, level FROM referral_tree
             WHERE descendant_id = $1 AND level <= 2
             ORDER BY level ASC`,
            [referrerId]
        );

        // Level 1: Direct referrer
        await client.query(
            `INSERT INTO referral_tree (ancestor_id, descendant_id, level)
             VALUES ($1, $2, 1)
             ON CONFLICT (ancestor_id, descendant_id) DO NOTHING`,
            [referrerId, newUserId]
        );

        // Level 2 & 3: Referrer's ancestors become higher-level ancestors
        for (const ancestor of ancestorsResult.rows) {
            const newLevel = ancestor.level + 1;
            if (newLevel <= 3) {
                await client.query(
                    `INSERT INTO referral_tree (ancestor_id, descendant_id, level)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (ancestor_id, descendant_id) DO NOTHING`,
                    [ancestor.ancestor_id, newUserId, newLevel]
                );
            }
        }

        await client.query('COMMIT');
        return true;

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[ReferralTree] Error registering chain:', error);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Distribute earnings when a user completes onboarding.
 * Pays all ancestors in the referral tree (up to 3 levels).
 *
 * @param {string} onboardedUserId - The user who just completed onboarding
 * @returns {Object[]} Array of earnings distributed
 */
async function distributeEarnings(onboardedUserId) {
    const client = await pool.connect();
    const earnings = [];

    try {
        await client.query('BEGIN');

        // Find all ancestors who should earn from this onboarding
        const ancestorsResult = await client.query(
            `SELECT rt.ancestor_id, rt.level, u.is_onboarded
             FROM referral_tree rt
             JOIN users u ON u.id = rt.ancestor_id
             WHERE rt.descendant_id = $1
             ORDER BY rt.level ASC`,
            [onboardedUserId]
        );

        for (const ancestor of ancestorsResult.rows) {
            // Only pay ancestors who are themselves onboarded
            if (!ancestor.is_onboarded) continue;

            const amount = EARNINGS_PER_LEVEL[ancestor.level];
            if (!amount) continue;

            // Check if this earning was already distributed (idempotency)
            const existingEarning = await client.query(
                `SELECT id FROM referral_earnings
                 WHERE earner_id = $1 AND source_user_id = $2`,
                [ancestor.ancestor_id, onboardedUserId]
            );

            if (existingEarning.rows.length > 0) continue;

            // Record the earning
            const earningResult = await client.query(
                `INSERT INTO referral_earnings (earner_id, source_user_id, level, amount)
                 VALUES ($1, $2, $3, $4)
                 RETURNING id`,
                [ancestor.ancestor_id, onboardedUserId, ancestor.level, amount]
            );

            // Credit the wallet
            await client.query(
                `UPDATE users
                 SET wallet_balance = wallet_balance + $1,
                     total_earned = total_earned + $1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [amount, ancestor.ancestor_id]
            );

            // Get updated balance
            const balanceResult = await client.query(
                `SELECT wallet_balance FROM users WHERE id = $1`,
                [ancestor.ancestor_id]
            );

            // Record wallet transaction
            await client.query(
                `INSERT INTO wallet_transactions
                 (user_id, type, amount, balance_after, description, reference_id)
                 VALUES ($1, 'referral_earning', $2, $3, $4, $5)`,
                [
                    ancestor.ancestor_id,
                    amount,
                    balanceResult.rows[0].wallet_balance,
                    `Level ${ancestor.level} referral earning`,
                    earningResult.rows[0].id
                ]
            );

            earnings.push({
                earnerId: ancestor.ancestor_id,
                level: ancestor.level,
                amount: amount
            });
        }

        await client.query('COMMIT');
        return earnings;

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[ReferralTree] Error distributing earnings:', error);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Get a user's referral tree for display
 *
 * @param {string} userId - The user whose tree to fetch
 * @returns {Object} Tree structure with levels
 */
async function getUserReferralTree(userId) {
    const result = await pool.query(
        `SELECT
            rt.level,
            rt.descendant_id,
            u.first_name,
            u.last_name,
            u.telegram_username,
            u.is_onboarded,
            u.created_at,
            rt2.descendant_id AS referred_by_descendant
         FROM referral_tree rt
         JOIN users u ON u.id = rt.descendant_id
         LEFT JOIN referral_tree rt2 ON rt2.descendant_id = rt.descendant_id AND rt2.level = 1
         WHERE rt.ancestor_id = $1
         ORDER BY rt.level ASC, u.created_at DESC`,
        [userId]
    );

    const tree = { level1: [], level2: [], level3: [] };

    for (const row of result.rows) {
        const node = {
            id: row.descendant_id,
            firstName: row.first_name,
            lastName: row.last_name,
            username: row.telegram_username,
            isOnboarded: row.is_onboarded,
            joinedAt: row.created_at,
            referredBy: row.referred_by_descendant
        };

        if (row.level === 1) tree.level1.push(node);
        else if (row.level === 2) tree.level2.push(node);
        else if (row.level === 3) tree.level3.push(node);
    }

    return tree;
}

/**
 * Get referral stats for a user
 */
async function getUserReferralStats(userId) {
    const result = await pool.query(
        `SELECT
            COUNT(DISTINCT CASE WHEN level = 1 THEN descendant_id END) AS level1_count,
            COUNT(DISTINCT CASE WHEN level = 2 THEN descendant_id END) AS level2_count,
            COUNT(DISTINCT CASE WHEN level = 3 THEN descendant_id END) AS level3_count,
            COUNT(DISTINCT descendant_id) AS total_network
         FROM referral_tree
         WHERE ancestor_id = $1`,
        [userId]
    );

    const earningsResult = await pool.query(
        `SELECT
            COALESCE(SUM(CASE WHEN level = 1 THEN amount ELSE 0 END), 0) AS level1_earnings,
            COALESCE(SUM(CASE WHEN level = 2 THEN amount ELSE 0 END), 0) AS level2_earnings,
            COALESCE(SUM(CASE WHEN level = 3 THEN amount ELSE 0 END), 0) AS level3_earnings,
            COALESCE(SUM(amount), 0) AS total_earnings
         FROM referral_earnings
         WHERE earner_id = $1`,
        [userId]
    );

    return {
        referrals: result.rows[0],
        earnings: earningsResult.rows[0]
    };
}

module.exports = {
    generateReferralCode,
    registerReferralChain,
    distributeEarnings,
    getUserReferralTree,
    getUserReferralStats,
    EARNINGS_PER_LEVEL
};
