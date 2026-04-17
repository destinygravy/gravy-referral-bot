/**
 * Authentication & User Registration Routes
 *
 * Handles user registration, onboarding verification,
 * and profile management.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { telegramAuthMiddleware } = require('../middleware/telegramAuth');
const { generateReferralCode, registerReferralChain, distributeEarnings } = require('../services/referralTree');
const { verifyOnboarding } = require('../services/gravyApi');

/**
 * POST /api/auth/register
 * Register or retrieve a user when they open the Mini App
 *
 * Body: { referralCode?: string }
 */
router.post('/register', telegramAuthMiddleware, async (req, res) => {
    const { id: telegramId, username, first_name, last_name } = req.telegramUser;
    const { referralCode } = req.body;

    try {
        // Check if user already exists
        let userResult = await pool.query(
            'SELECT * FROM users WHERE telegram_id = $1',
            [telegramId]
        );

        if (userResult.rows.length > 0) {
            // Existing user — return their profile
            const user = userResult.rows[0];
            return res.json({
                success: true,
                isNew: false,
                user: formatUserResponse(user)
            });
        }

        // New user — register them
        let referrerId = null;

        if (referralCode) {
            const referrerResult = await pool.query(
                'SELECT id, is_onboarded FROM users WHERE referral_code = $1',
                [referralCode]
            );

            if (referrerResult.rows.length > 0 && referrerResult.rows[0].is_onboarded) {
                referrerId = referrerResult.rows[0].id;
            }
        }

        // Generate unique referral code for this user
        let newReferralCode;
        let codeExists = true;
        while (codeExists) {
            newReferralCode = generateReferralCode();
            const check = await pool.query(
                'SELECT id FROM users WHERE referral_code = $1',
                [newReferralCode]
            );
            codeExists = check.rows.length > 0;
        }

        // Create the user
        const insertResult = await pool.query(
            `INSERT INTO users (telegram_id, telegram_username, first_name, last_name, referral_code, referred_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [telegramId, username, first_name, last_name, newReferralCode, referrerId]
        );

        const newUser = insertResult.rows[0];

        // If referred by someone, register the referral chain
        if (referrerId) {
            await registerReferralChain(newUser.id, referrerId);
        }

        return res.json({
            success: true,
            isNew: true,
            user: formatUserResponse(newUser)
        });

    } catch (error) {
        console.error('[Auth] Registration error:', error);
        return res.status(500).json({
            error: 'Registration failed. Please try again.'
        });
    }
});

/**
 * POST /api/auth/verify-onboarding
 * User submits their Gravy virtual account for verification
 *
 * Body: { gravyAccountNumber: string }
 */
router.post('/verify-onboarding', telegramAuthMiddleware, async (req, res) => {
    const { id: telegramId } = req.telegramUser;
    const { gravyAccountNumber } = req.body;

    if (!gravyAccountNumber || gravyAccountNumber.trim().length === 0) {
        return res.status(400).json({
            error: 'Please provide your Gravy virtual account number'
        });
    }

    try {
        // Get user
        const userResult = await pool.query(
            'SELECT * FROM users WHERE telegram_id = $1',
            [telegramId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found. Please register first.' });
        }

        const user = userResult.rows[0];

        if (user.is_onboarded) {
            return res.status(400).json({
                error: 'You are already verified!',
                user: formatUserResponse(user)
            });
        }

        // Check if account number is already claimed by another user
        const duplicateCheck = await pool.query(
            'SELECT id FROM users WHERE gravy_account_number = $1 AND telegram_id != $2',
            [gravyAccountNumber.trim(), telegramId]
        );

        if (duplicateCheck.rows.length > 0) {
            return res.status(400).json({
                error: 'This Gravy account is already linked to another user.'
            });
        }

        // Call Gravy API to verify onboarding
        const verification = await verifyOnboarding(gravyAccountNumber.trim());

        // Log the verification attempt (including full API response for audit)
        await pool.query(
            `INSERT INTO onboarding_verifications
             (user_id, gravy_account_number, api_response_status, api_response_body, verified)
             VALUES ($1, $2, $3, $4, $5)`,
            [
                user.id,
                gravyAccountNumber.trim(),
                verification.verified ? 'success' : 'failed',
                verification.apiResponse ? JSON.stringify(verification.apiResponse) : null,
                verification.verified
            ]
        );

        if (!verification.verified) {
            return res.status(400).json({
                error: verification.error || 'Onboarding verification failed. Make sure you have completed onboarding on Gravy Mobile.'
            });
        }

        // Mark user as onboarded
        const updatedUser = await pool.query(
            `UPDATE users
             SET is_onboarded = TRUE,
                 gravy_account_number = $1,
                 onboarding_verified_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING *`,
            [gravyAccountNumber.trim(), user.id]
        );

        // Distribute referral earnings to ancestors
        const earnings = await distributeEarnings(user.id);

        return res.json({
            success: true,
            message: 'Congratulations! Your onboarding is verified. You can now start referring others!',
            user: formatUserResponse(updatedUser.rows[0]),
            earningsDistributed: earnings.length
        });

    } catch (error) {
        console.error('[Auth] Verification error:', error);
        return res.status(500).json({
            error: 'Verification failed. Please try again later.'
        });
    }
});

/**
 * GET /api/auth/me
 * Get current user's profile
 */
router.get('/me', telegramAuthMiddleware, async (req, res) => {
    const { id: telegramId } = req.telegramUser;

    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE telegram_id = $1',
            [telegramId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        return res.json({
            success: true,
            user: formatUserResponse(result.rows[0])
        });
    } catch (error) {
        console.error('[Auth] Profile error:', error);
        return res.status(500).json({ error: 'Failed to load profile' });
    }
});

/**
 * Format user data for API responses (strip sensitive fields)
 */
function formatUserResponse(user) {
    return {
        id: user.id,
        telegramId: user.telegram_id,
        username: user.telegram_username,
        firstName: user.first_name,
        lastName: user.last_name,
        referralCode: user.referral_code,
        isOnboarded: user.is_onboarded,
        onboardingVerifiedAt: user.onboarding_verified_at,
        walletBalance: parseFloat(user.wallet_balance),
        totalEarned: parseFloat(user.total_earned),
        createdAt: user.created_at
    };
}

module.exports = router;
