/**
 * Wallet Routes
 *
 * Handles wallet balance, transaction history, and withdrawals.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { telegramAuthMiddleware } = require('../middleware/telegramAuth');

/**
 * GET /api/wallet/balance
 * Get current wallet balance and summary
 */
router.get('/balance', telegramAuthMiddleware, async (req, res) => {
    const { id: telegramId } = req.telegramUser;

    try {
        const result = await pool.query(
            `SELECT wallet_balance, total_earned FROM users WHERE telegram_id = $1`,
            [telegramId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = result.rows[0];

        // Get pending withdrawal amount
        const pendingResult = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) AS pending_amount
             FROM withdrawal_requests
             WHERE user_id = (SELECT id FROM users WHERE telegram_id = $1)
             AND status IN ('pending', 'approved')`,
            [telegramId]
        );

        return res.json({
            success: true,
            wallet: {
                balance: parseFloat(user.wallet_balance),
                totalEarned: parseFloat(user.total_earned),
                pendingWithdrawal: parseFloat(pendingResult.rows[0].pending_amount),
                availableBalance: parseFloat(user.wallet_balance) - parseFloat(pendingResult.rows[0].pending_amount)
            }
        });

    } catch (error) {
        console.error('[Wallet] Balance error:', error);
        return res.status(500).json({ error: 'Failed to load wallet' });
    }
});

/**
 * GET /api/wallet/transactions
 * Get wallet transaction history
 */
router.get('/transactions', telegramAuthMiddleware, async (req, res) => {
    const { id: telegramId } = req.telegramUser;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = (page - 1) * limit;

    try {
        const userResult = await pool.query(
            'SELECT id FROM users WHERE telegram_id = $1',
            [telegramId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const userId = userResult.rows[0].id;

        const [transactions, countResult] = await Promise.all([
            pool.query(
                `SELECT type, amount, balance_after, description, created_at
                 FROM wallet_transactions
                 WHERE user_id = $1
                 ORDER BY created_at DESC
                 LIMIT $2 OFFSET $3`,
                [userId, limit, offset]
            ),
            pool.query(
                'SELECT COUNT(*) FROM wallet_transactions WHERE user_id = $1',
                [userId]
            )
        ]);

        return res.json({
            success: true,
            transactions: transactions.rows.map(tx => ({
                type: tx.type,
                amount: parseFloat(tx.amount),
                balanceAfter: parseFloat(tx.balance_after),
                description: tx.description,
                date: tx.created_at
            })),
            pagination: {
                page,
                limit,
                total: parseInt(countResult.rows[0].count),
                totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
            }
        });

    } catch (error) {
        console.error('[Wallet] Transactions error:', error);
        return res.status(500).json({ error: 'Failed to load transactions' });
    }
});

/**
 * Tiered withdrawal amounts
 * Users progress through tiers with each completed withdrawal
 */
const WITHDRAWAL_TIERS = [
    { tier: 1, amount: 1000 },  // 0 completed → tier 1 (₦1,000)
    { tier: 2, amount: 2000 },  // 1 completed → tier 2 (₦2,000)
    { tier: 3, amount: 3000 },  // 2 completed → tier 3 (₦3,000)
    { tier: 4, amount: 5000 },  // 3 completed → tier 4 (₦5,000)
    { tier: 5, amount: 10000 }, // 4 completed → tier 5 (₦10,000)
    // 5+ completed → unlimited (can choose ₦5,000 or ₦10,000)
];

/**
 * Helper: Get current tier info based on completed withdrawals
 */
function getTierInfo(completedWithdrawals) {
    if (completedWithdrawals < WITHDRAWAL_TIERS.length) {
        const tier = WITHDRAWAL_TIERS[completedWithdrawals];
        return {
            tierNumber: tier.tier,
            isUnlimited: false,
            allowedAmounts: [tier.amount],
            nextTierAmount: completedWithdrawals + 1 < WITHDRAWAL_TIERS.length
                ? WITHDRAWAL_TIERS[completedWithdrawals + 1].amount
                : null
        };
    } else {
        // Unlimited tier: can choose ₦5,000 or ₦10,000
        return {
            tierNumber: 5,
            isUnlimited: true,
            allowedAmounts: [5000, 10000],
            nextTierAmount: null
        };
    }
}

/**
 * POST /api/wallet/withdraw
 * Request a withdrawal with tiered amounts
 *
 * Body: { amount: number }
 */
router.post('/withdraw', telegramAuthMiddleware, async (req, res) => {
    const { id: telegramId } = req.telegramUser;
    const { amount } = req.body;

    if (!amount || typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({
            error: 'Invalid amount'
        });
    }

    try {
        const userResult = await pool.query(
            'SELECT * FROM users WHERE telegram_id = $1',
            [telegramId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = userResult.rows[0];

        // Check onboarding
        if (!user.is_onboarded || !user.gravy_account_number) {
            return res.status(403).json({
                error: 'You must complete onboarding and have a verified Gravy account to withdraw.'
            });
        }

        // Count completed withdrawals (status = 'processed')
        const completedResult = await pool.query(
            `SELECT COUNT(*) as count FROM withdrawal_requests
             WHERE user_id = $1 AND status = 'processed'`,
            [user.id]
        );
        const completedWithdrawals = parseInt(completedResult.rows[0].count);

        // Get tier info
        const tierInfo = getTierInfo(completedWithdrawals);

        // Validate amount against tier
        if (!tierInfo.allowedAmounts.includes(amount)) {
            if (tierInfo.isUnlimited) {
                return res.status(400).json({
                    error: `Unlimited tier: You can only withdraw ₦5,000 or ₦10,000. You requested ₦${amount}.`,
                    tier: tierInfo.tierNumber,
                    isUnlimited: true,
                    allowedAmounts: tierInfo.allowedAmounts
                });
            } else {
                return res.status(400).json({
                    error: `Tier ${tierInfo.tierNumber}: You must withdraw exactly ₦${tierInfo.allowedAmounts[0]}. You requested ₦${amount}.`,
                    tier: tierInfo.tierNumber,
                    allowedAmounts: tierInfo.allowedAmounts
                });
            }
        }

        // Check for existing pending/approved withdrawal
        const existingWithdrawalResult = await pool.query(
            `SELECT id FROM withdrawal_requests
             WHERE user_id = $1 AND status IN ('pending', 'approved')
             LIMIT 1`,
            [user.id]
        );

        if (existingWithdrawalResult.rows.length > 0) {
            return res.status(400).json({
                error: 'You already have a pending or approved withdrawal. Please wait for it to be processed.'
            });
        }

        // Check available balance (excluding pending/approved withdrawals)
        const pendingResult = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) AS pending
             FROM withdrawal_requests
             WHERE user_id = $1 AND status IN ('pending', 'approved')`,
            [user.id]
        );

        const availableBalance = parseFloat(user.wallet_balance) - parseFloat(pendingResult.rows[0].pending);

        if (amount > availableBalance) {
            return res.status(400).json({
                error: `Insufficient balance. You have ₦${availableBalance.toFixed(2)} available. Tier ${tierInfo.tierNumber} requires ₦${amount}.`,
                availableBalance: availableBalance,
                required: amount,
                shortfall: amount - availableBalance
            });
        }

        // Create withdrawal request
        await pool.query(
            `INSERT INTO withdrawal_requests (user_id, amount, destination_account)
             VALUES ($1, $2, $3)`,
            [user.id, amount, user.gravy_account_number]
        );

        return res.json({
            success: true,
            message: `Withdrawal request of ₦${amount.toFixed(2)} submitted successfully. It will be reviewed by admin and processed to your Gravy account.`,
            tier: tierInfo.tierNumber,
            amount: amount
        });

    } catch (error) {
        console.error('[Wallet] Withdrawal error:', error);
        return res.status(500).json({ error: 'Withdrawal request failed' });
    }
});

/**
 * GET /api/wallet/withdrawal-info
 * Get current withdrawal tier info and eligibility status
 */
router.get('/withdrawal-info', telegramAuthMiddleware, async (req, res) => {
    const { id: telegramId } = req.telegramUser;

    try {
        const userResult = await pool.query(
            'SELECT * FROM users WHERE telegram_id = $1',
            [telegramId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = userResult.rows[0];

        // Count completed withdrawals
        const completedResult = await pool.query(
            `SELECT COUNT(*) as count FROM withdrawal_requests
             WHERE user_id = $1 AND status = 'processed'`,
            [user.id]
        );
        const completedWithdrawals = parseInt(completedResult.rows[0].count);

        // Get tier info
        const tierInfo = getTierInfo(completedWithdrawals);

        // Check for pending/approved withdrawal
        const pendingWithdrawalResult = await pool.query(
            `SELECT id, amount, status FROM withdrawal_requests
             WHERE user_id = $1 AND status IN ('pending', 'approved')
             LIMIT 1`,
            [user.id]
        );
        const hasPendingWithdrawal = pendingWithdrawalResult.rows.length > 0;

        // Get available balance
        const pendingResult = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) AS pending
             FROM withdrawal_requests
             WHERE user_id = $1 AND status IN ('pending', 'approved')`,
            [user.id]
        );

        const availableBalance = parseFloat(user.wallet_balance) - parseFloat(pendingResult.rows[0].pending);

        // Check if can withdraw now
        const canWithdraw = user.is_onboarded
            && !hasPendingWithdrawal
            && availableBalance >= Math.min(...tierInfo.allowedAmounts);

        // Calculate progress to next tier
        let progressToNextTier = null;
        if (!tierInfo.isUnlimited && tierInfo.nextTierAmount) {
            progressToNextTier = {
                current: completedWithdrawals,
                next: completedWithdrawals + 1,
                currentAmount: tierInfo.allowedAmounts[0],
                nextAmount: tierInfo.nextTierAmount,
                completionsToNext: 1
            };
        }

        return res.json({
            success: true,
            withdrawal: {
                tierNumber: tierInfo.tierNumber,
                isUnlimited: tierInfo.isUnlimited,
                allowedAmounts: tierInfo.allowedAmounts,
                completedWithdrawals: completedWithdrawals,
                canWithdraw: canWithdraw,
                availableBalance: availableBalance,
                isOnboarded: user.is_onboarded,
                hasPendingWithdrawal: hasPendingWithdrawal,
                pendingWithdrawal: hasPendingWithdrawal ? {
                    amount: parseFloat(pendingWithdrawalResult.rows[0].amount),
                    status: pendingWithdrawalResult.rows[0].status
                } : null,
                progressToNextTier: progressToNextTier
            }
        });

    } catch (error) {
        console.error('[Wallet] Withdrawal info error:', error);
        return res.status(500).json({ error: 'Failed to load withdrawal info' });
    }
});

module.exports = router;
