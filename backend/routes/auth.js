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
 * POST /api/auth/save-referral
 * Called by the bot when a user clicks a referral link (/start ref_CODE).
 * Saves the referral code server-side so it's available when the user
 * opens the Mini App (since Telegram strips URL params from WebApp buttons).
 *
 * Body: { telegramId: number, referralCode: string }
 * Auth: Internal secret (BOT_INTERNAL_SECRET)
 */
router.post('/save-referral', async (req, res) => {
    const { telegramId, referralCode, secret } = req.body;

    // Simple shared-secret auth between bot and API
    if (secret !== process.env.BOT_INTERNAL_SECRET) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    if (!telegramId || !referralCode) {
        return res.status(400).json({ error: 'telegramId and referralCode required' });
    }

    try {
        // Upsert: save or update the pending referral for this telegram user
        await pool.query(
            `INSERT INTO pending_referrals (telegram_id, referral_code)
             VALUES ($1, $2)
             ON CONFLICT (telegram_id)
             DO UPDATE SET referral_code = $2, created_at = CURRENT_TIMESTAMP`,
            [telegramId, referralCode]
        );

        console.log(`[Auth] Saved pending referral: telegramId=${telegramId}, code=${referralCode}`);
        return res.json({ success: true });
    } catch (error) {
        console.error('[Auth] Save referral error:', error);
        return res.status(500).json({ error: 'Failed to save referral' });
    }
});

/**
 * POST /api/auth/register
 * Register or retrieve a user when they open the Mini App
 *
 * Body: { referralCode?: string }
 */
router.post('/register', telegramAuthMiddleware, async (req, res) => {
    const { id: telegramId, username, first_name, last_name } = req.telegramUser;
    let { referralCode } = req.body;

    // Check for server-side pending referral (saved by bot when user clicked a referral link)
    if (!referralCode) {
        try {
            const pendingResult = await pool.query(
                'SELECT referral_code FROM pending_referrals WHERE telegram_id = $1',
                [telegramId]
            );
            if (pendingResult.rows.length > 0) {
                referralCode = pendingResult.rows[0].referral_code;
                console.log(`[Auth] Found pending referral for telegramId=${telegramId}: ${referralCode}`);
                // Clean up the pending referral
                await pool.query('DELETE FROM pending_referrals WHERE telegram_id = $1', [telegramId]);
            }
        } catch (pendingErr) {
            console.error('[Auth] Pending referral lookup error:', pendingErr);
            // Non-fatal — continue without referral code
        }
    }

    console.log(`[Auth] Registration attempt: telegramId=${telegramId}, username=${username}, referralCode=${referralCode || 'NONE'}`);

    try {
        // Check if user already exists
        let userResult = await pool.query(
            'SELECT * FROM users WHERE telegram_id = $1',
            [telegramId]
        );

        if (userResult.rows.length > 0) {
            // Existing user — check if we can retroactively link a referrer
            const user = userResult.rows[0];

            if (referralCode && !user.referred_by) {
                // User has no referrer but opened the app via a referral link — link them now
                try {
                    const referrerResult = await pool.query(
                        'SELECT id, first_name, referral_code FROM users WHERE referral_code = $1',
                        [referralCode]
                    );

                    if (referrerResult.rows.length > 0) {
                        const referrerId = referrerResult.rows[0].id;

                        // Make sure they're not trying to refer themselves
                        if (referrerId !== user.id) {
                            console.log(`[Auth] Retroactive referral link: ${user.first_name} (${user.id}) → referred by ${referrerResult.rows[0].first_name} (${referrerId})`);

                            await pool.query(
                                'UPDATE users SET referred_by = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                                [referrerId, user.id]
                            );

                            // Register the referral chain
                            await registerReferralChain(user.id, referrerId);

                            // If user is already onboarded, distribute earnings immediately
                            if (user.is_onboarded) {
                                const earnings = await distributeEarnings(user.id);
                                console.log(`[Auth] Retroactive earnings distributed: ${earnings.length} payments`);
                            }

                            // Refresh user data after update
                            const updatedResult = await pool.query(
                                'SELECT * FROM users WHERE id = $1', [user.id]
                            );
                            return res.json({
                                success: true,
                                isNew: false,
                                user: formatUserResponse(updatedResult.rows[0])
                            });
                        }
                    }
                } catch (retroError) {
                    console.error('[Auth] Retroactive referral link error:', retroError);
                    // Non-fatal — still return the user profile
                }
            }

            return res.json({
                success: true,
                isNew: false,
                user: formatUserResponse(user)
            });
        }

        // New user — register them
        let referrerId = null;

        if (referralCode) {
            console.log(`[Auth] Looking up referral code: ${referralCode}`);
            const referrerResult = await pool.query(
                'SELECT id, first_name, referral_code FROM users WHERE referral_code = $1',
                [referralCode]
            );

            if (referrerResult.rows.length > 0) {
                referrerId = referrerResult.rows[0].id;
                console.log(`[Auth] Found referrer: ${referrerResult.rows[0].first_name} (${referrerId})`);
            } else {
                console.log(`[Auth] WARNING: Referral code "${referralCode}" not found in database`);
            }
        } else {
            console.log(`[Auth] No referral code provided`);
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

        // Extract verified name from Gravy account (e.g. "Gravy - Oseni Azeez" → "Oseni Azeez")
        let verifiedFirstName = user.first_name;
        let verifiedLastName = user.last_name;
        if (verification.accountData && verification.accountData.fullName) {
            const nameParts = verification.accountData.fullName.split(' ');
            if (nameParts.length >= 2) {
                verifiedFirstName = nameParts[0];
                verifiedLastName = nameParts.slice(1).join(' ');
            } else if (nameParts.length === 1) {
                verifiedFirstName = nameParts[0];
            }
        }

        // Mark user as onboarded and update name from Gravy account
        const updatedUser = await pool.query(
            `UPDATE users
             SET is_onboarded = TRUE,
                 gravy_account_number = $1,
                 first_name = $2,
                 last_name = $3,
                 onboarding_verified_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $4
             RETURNING *`,
            [gravyAccountNumber.trim(), verifiedFirstName, verifiedLastName, user.id]
        );

        // Distribute referral earnings to ancestors
        const earnings = await distributeEarnings(user.id);

        // Retroactive fix: if this user was referred but the chain wasn't
        // created (because referrer wasn't onboarded at the time), create it now
        if (!user.referred_by) {
            // Check if this user was registered with a referral code that wasn't linked
            // (This handles old accounts that missed the chain)
            console.log(`[Auth] User ${user.id} has no referred_by — skipping retroactive chain`);
        }

        // Also check: now that this user is onboarded, are there any
        // descendants who are already onboarded but whose earnings weren't paid?
        // (Handles case where descendant verified before this ancestor did)
        try {
            const unpaidDescendants = await pool.query(
                `SELECT rt.descendant_id, rt.level
                 FROM referral_tree rt
                 JOIN users u ON u.id = rt.descendant_id
                 LEFT JOIN referral_earnings re ON re.earner_id = rt.ancestor_id AND re.source_user_id = rt.descendant_id
                 WHERE rt.ancestor_id = $1
                   AND u.is_onboarded = TRUE
                   AND re.id IS NULL`,
                [user.id]
            );

            if (unpaidDescendants.rows.length > 0) {
                console.log(`[Auth] Found ${unpaidDescendants.rows.length} unpaid descendants for newly onboarded user ${user.id}`);
                for (const desc of unpaidDescendants.rows) {
                    await distributeEarnings(desc.descendant_id);
                }
            }
        } catch (retroError) {
            console.error('[Auth] Retroactive earnings error:', retroError);
            // Non-fatal — don't fail the verification
        }

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
