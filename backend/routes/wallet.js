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
 * POST /api/wallet/withdraw
 * Request a withdrawal (future feature, ready when you add payout)
 *
 * Body: { amount: number }
 */
router.post('/withdraw', telegramAuthMiddleware, async (req, res) => {
    const { id: telegramId } = req.telegramUser;
    const { amount } = req.body;

    const MIN_WITHDRAWAL = parseFloat(process.env.MIN_WITHDRAWAL || '500');

    if (!amount || amount < MIN_WITHDRAWAL) {
        return res.status(400).json({
            error: `Minimum withdrawal amount is ₦${MIN_WITHDRAWAL}`
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

        if (!user.is_onboarded || !user.gravy_account_number) {
            return res.status(403).json({
                error: 'You must complete onboarding and have a verified Gravy account.'
            });
        }

        // Check available balance (excluding pending withdrawals)
        const pendingResult = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) AS pending
             FROM withdrawal_requests
             WHERE user_id = $1 AND status IN ('pending', 'approved')`,
            [user.id]
        );

        const availableBalance = parseFloat(user.wallet_balance) - parseFloat(pendingResult.rows[0].pending);

        if (amount > availableBalance) {
            return res.status(400).json({
                error: `Insufficient balance. Available: ₦${availableBalance.toFixed(2)}`
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
            message: `Withdrawal request of ₦${amount.toFixed(2)} submitted. It will be reviewed and processed to your Gravy account.`
        });

    } catch (error) {
        console.error('[Wallet] Withdrawal error:', error);
        return res.status(500).json({ error: 'Withdrawal request failed' });
    }
});

module.exports = router;
