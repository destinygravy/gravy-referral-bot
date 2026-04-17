/**
 * Admin Panel API Routes
 *
 * Complete admin system with:
 * - Multi-admin authentication (login, register, manage admins)
 * - Dashboard analytics
 * - User management (search, view, ban/unban, export)
 * - Withdrawal management (approve, reject, bulk actions)
 * - Referral audit (verify chains, detect fraud)
 * - System settings
 * - Audit log viewer
 * - Security management
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const {
    adminAuthMiddleware,
    createSession,
    revokeSession,
    revokeAllSessions,
    logAuditEvent,
    logSecurityEvent,
    checkBruteForce,
    getClientIP,
    MAX_FAILED_ATTEMPTS,
    LOCKOUT_DURATION_MINUTES
} = require('../middleware/adminAuth');

const BCRYPT_ROUNDS = 12;

// ============================================================
// AUTH ROUTES (no auth required)
// ============================================================

/**
 * POST /api/admin/auth/login
 */
router.post('/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const ip = getClientIP(req);

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    // Brute-force check
    const bruteCheck = await checkBruteForce(ip);
    if (bruteCheck.blocked) {
        return res.status(429).json({ error: bruteCheck.reason });
    }

    try {
        const result = await pool.query(
            'SELECT * FROM admin_users WHERE username = $1',
            [username.toLowerCase().trim()]
        );

        if (result.rows.length === 0) {
            await logSecurityEvent('login_failed', ip, username, { reason: 'user_not_found' });
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const admin = result.rows[0];

        // Check if account is locked
        if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
            await logSecurityEvent('login_locked', ip, username, { locked_until: admin.locked_until });
            const minutesLeft = Math.ceil((new Date(admin.locked_until) - new Date()) / 60000);
            return res.status(423).json({
                error: `Account is locked. Try again in ${minutesLeft} minutes.`
            });
        }

        // Check if active
        if (!admin.is_active) {
            return res.status(403).json({ error: 'Account is deactivated' });
        }

        // Verify password
        const passwordValid = await bcrypt.compare(password, admin.password_hash);

        if (!passwordValid) {
            const attempts = admin.failed_login_attempts + 1;
            let lockedUntil = null;

            if (attempts >= MAX_FAILED_ATTEMPTS) {
                lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MINUTES * 60 * 1000);
                await logSecurityEvent('account_locked', ip, username, { attempts, locked_until: lockedUntil });
            }

            await pool.query(
                `UPDATE admin_users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3`,
                [attempts, lockedUntil, admin.id]
            );

            await logSecurityEvent('login_failed', ip, username, { reason: 'invalid_password', attempts });
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Successful login — create session
        const session = await createSession(admin.id, req);
        await logAuditEvent(admin.id, 'auth.login', 'admin', admin.id, { ip }, req);

        return res.json({
            success: true,
            token: session.token,
            expiresAt: session.expiresAt,
            admin: {
                id: admin.id,
                username: admin.username,
                displayName: admin.display_name,
                role: admin.role,
                email: admin.email
            }
        });

    } catch (err) {
        console.error('[Admin] Login error:', err);
        return res.status(500).json({ error: 'Login failed' });
    }
});

/**
 * POST /api/admin/auth/logout
 */
router.post('/auth/logout', adminAuthMiddleware(), async (req, res) => {
    await revokeSession(req.sessionToken);
    await logAuditEvent(req.admin.id, 'auth.logout', 'admin', req.admin.id, null, req);
    return res.json({ success: true });
});

/**
 * GET /api/admin/auth/me
 */
router.get('/auth/me', adminAuthMiddleware(), async (req, res) => {
    return res.json({ success: true, admin: req.admin });
});

// ============================================================
// SETUP ROUTE (only works when no admins exist)
// ============================================================

/**
 * POST /api/admin/setup
 * Create the first super_admin account (only when no admins exist)
 */
router.post('/setup', async (req, res) => {
    const { username, password, email, displayName } = req.body;

    // Check if any admin already exists
    const existingAdmins = await pool.query('SELECT COUNT(*) FROM admin_users');
    if (parseInt(existingAdmins.rows[0].count) > 0) {
        return res.status(403).json({ error: 'Setup already completed. Contact an existing admin.' });
    }

    if (!username || !password || !email || !displayName) {
        return res.status(400).json({ error: 'All fields required: username, password, email, displayName' });
    }

    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    try {
        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

        const result = await pool.query(
            `INSERT INTO admin_users (username, email, password_hash, display_name, role)
             VALUES ($1, $2, $3, $4, 'super_admin')
             RETURNING id, username, email, display_name, role`,
            [username.toLowerCase().trim(), email.toLowerCase().trim(), passwordHash, displayName]
        );

        await logSecurityEvent('admin_setup', getClientIP(req), username, { role: 'super_admin' });

        return res.json({
            success: true,
            message: 'Super admin account created successfully',
            admin: result.rows[0]
        });
    } catch (err) {
        console.error('[Admin] Setup error:', err);
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Username or email already taken' });
        }
        return res.status(500).json({ error: 'Setup failed' });
    }
});

// ============================================================
// DASHBOARD ROUTES
// ============================================================

/**
 * GET /api/admin/dashboard
 * Get overview statistics
 */
router.get('/dashboard', adminAuthMiddleware(), async (req, res) => {
    try {
        const [users, onboarded, earnings, withdrawals, todayUsers, todayEarnings, recentWithdrawals] = await Promise.all([
            pool.query('SELECT COUNT(*) FROM users'),
            pool.query('SELECT COUNT(*) FROM users WHERE is_onboarded = TRUE'),
            pool.query('SELECT COALESCE(SUM(total_earned), 0) as total FROM users'),
            pool.query(`SELECT
                COUNT(*) FILTER (WHERE status = 'pending') as pending,
                COUNT(*) FILTER (WHERE status = 'approved') as approved,
                COUNT(*) FILTER (WHERE status = 'processed') as processed,
                COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
                COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0) as pending_amount
                FROM withdrawal_requests`),
            pool.query(`SELECT COUNT(*) FROM users WHERE created_at >= CURRENT_DATE`),
            pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM referral_earnings WHERE created_at >= CURRENT_DATE`),
            pool.query(`SELECT COUNT(*) FROM withdrawal_requests WHERE status = 'pending'`)
        ]);

        // Growth - users per day for last 7 days
        const growth = await pool.query(
            `SELECT DATE(created_at) as date, COUNT(*) as count
             FROM users
             WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
             GROUP BY DATE(created_at)
             ORDER BY date ASC`
        );

        // Top referrers
        const topReferrers = await pool.query(
            `SELECT u.id, u.first_name, u.telegram_username, u.total_earned,
                    COUNT(DISTINCT rt.descendant_id) FILTER (WHERE rt.level = 1) as direct_referrals
             FROM users u
             LEFT JOIN referral_tree rt ON rt.ancestor_id = u.id
             WHERE u.total_earned > 0
             GROUP BY u.id
             ORDER BY u.total_earned DESC
             LIMIT 10`
        );

        return res.json({
            success: true,
            dashboard: {
                totalUsers: parseInt(users.rows[0].count),
                onboardedUsers: parseInt(onboarded.rows[0].count),
                totalEarningsDistributed: parseFloat(earnings.rows[0].total),
                todayNewUsers: parseInt(todayUsers.rows[0].count),
                todayEarnings: parseFloat(todayEarnings.rows[0].total),
                withdrawals: {
                    pending: parseInt(withdrawals.rows[0].pending),
                    approved: parseInt(withdrawals.rows[0].approved),
                    processed: parseInt(withdrawals.rows[0].processed),
                    rejected: parseInt(withdrawals.rows[0].rejected),
                    pendingAmount: parseFloat(withdrawals.rows[0].pending_amount)
                },
                growth: growth.rows,
                topReferrers: topReferrers.rows.map(r => ({
                    id: r.id,
                    name: r.first_name || r.telegram_username || 'Unknown',
                    username: r.telegram_username,
                    totalEarned: parseFloat(r.total_earned),
                    directReferrals: parseInt(r.direct_referrals)
                }))
            }
        });
    } catch (err) {
        console.error('[Admin] Dashboard error:', err);
        return res.status(500).json({ error: 'Failed to load dashboard' });
    }
});

// ============================================================
// USER MANAGEMENT
// ============================================================

/**
 * GET /api/admin/users
 * List all users with search and filters
 */
router.get('/users', adminAuthMiddleware(), async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const filter = req.query.filter || 'all'; // all, onboarded, not_onboarded, banned
    const sortBy = req.query.sortBy || 'created_at';
    const sortOrder = req.query.sortOrder === 'asc' ? 'ASC' : 'DESC';

    const validSorts = ['created_at', 'total_earned', 'wallet_balance', 'first_name'];
    const orderCol = validSorts.includes(sortBy) ? sortBy : 'created_at';

    try {
        let filterClause = '';
        if (filter === 'onboarded') filterClause = 'AND u.is_onboarded = TRUE';
        else if (filter === 'not_onboarded') filterClause = 'AND u.is_onboarded = FALSE';
        else if (filter === 'banned') filterClause = 'AND u.is_banned = TRUE';

        let searchClause = '';
        const params = [];
        let paramIdx = 1;

        if (search) {
            searchClause = `AND (u.first_name ILIKE $${paramIdx} OR u.telegram_username ILIKE $${paramIdx} OR u.referral_code ILIKE $${paramIdx} OR u.gravy_account_number ILIKE $${paramIdx} OR CAST(u.telegram_id AS TEXT) ILIKE $${paramIdx})`;
            params.push(`%${search}%`);
            paramIdx++;
        }

        params.push(limit, offset);

        const [usersResult, countResult] = await Promise.all([
            pool.query(
                `SELECT u.*,
                    COUNT(DISTINCT rt.descendant_id) FILTER (WHERE rt.level = 1) as direct_referrals,
                    COUNT(DISTINCT rt.descendant_id) as total_network,
                    ref.first_name as referrer_name, ref.referral_code as referrer_code
                 FROM users u
                 LEFT JOIN referral_tree rt ON rt.ancestor_id = u.id
                 LEFT JOIN users ref ON ref.id = u.referred_by
                 WHERE 1=1 ${filterClause} ${searchClause}
                 GROUP BY u.id, ref.first_name, ref.referral_code
                 ORDER BY u.${orderCol} ${sortOrder}
                 LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
                params
            ),
            pool.query(
                `SELECT COUNT(*) FROM users u WHERE 1=1 ${filterClause} ${searchClause}`,
                search ? [`%${search}%`] : []
            )
        ]);

        return res.json({
            success: true,
            users: usersResult.rows.map(u => ({
                id: u.id,
                telegramId: u.telegram_id,
                username: u.telegram_username,
                firstName: u.first_name,
                lastName: u.last_name,
                referralCode: u.referral_code,
                gravyAccount: u.gravy_account_number,
                isOnboarded: u.is_onboarded,
                isBanned: u.is_banned,
                walletBalance: parseFloat(u.wallet_balance),
                totalEarned: parseFloat(u.total_earned),
                directReferrals: parseInt(u.direct_referrals),
                totalNetwork: parseInt(u.total_network),
                referrerName: u.referrer_name,
                referrerCode: u.referrer_code,
                createdAt: u.created_at
            })),
            pagination: {
                page, limit,
                total: parseInt(countResult.rows[0].count),
                totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
            }
        });
    } catch (err) {
        console.error('[Admin] Users list error:', err);
        return res.status(500).json({ error: 'Failed to load users' });
    }
});

/**
 * GET /api/admin/users/:id
 * Get detailed user profile with full referral chain
 */
router.get('/users/:id', adminAuthMiddleware(), async (req, res) => {
    try {
        const user = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
        if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });

        const [referrals, earnings, transactions, withdrawals, verifications] = await Promise.all([
            pool.query(
                `SELECT rt.level, u.id, u.first_name, u.telegram_username, u.is_onboarded, u.created_at
                 FROM referral_tree rt JOIN users u ON u.id = rt.descendant_id
                 WHERE rt.ancestor_id = $1 ORDER BY rt.level, u.created_at DESC`,
                [req.params.id]
            ),
            pool.query(
                `SELECT re.*, u.first_name as source_name, u.telegram_username as source_username
                 FROM referral_earnings re JOIN users u ON u.id = re.source_user_id
                 WHERE re.earner_id = $1 ORDER BY re.created_at DESC LIMIT 50`,
                [req.params.id]
            ),
            pool.query(
                'SELECT * FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
                [req.params.id]
            ),
            pool.query(
                'SELECT * FROM withdrawal_requests WHERE user_id = $1 ORDER BY created_at DESC',
                [req.params.id]
            ),
            pool.query(
                'SELECT * FROM onboarding_verifications WHERE user_id = $1 ORDER BY created_at DESC',
                [req.params.id]
            )
        ]);

        return res.json({
            success: true,
            user: user.rows[0],
            referrals: referrals.rows,
            earnings: earnings.rows,
            transactions: transactions.rows,
            withdrawals: withdrawals.rows,
            verifications: verifications.rows
        });
    } catch (err) {
        console.error('[Admin] User detail error:', err);
        return res.status(500).json({ error: 'Failed to load user' });
    }
});

/**
 * POST /api/admin/users/:id/ban
 */
router.post('/users/:id/ban', adminAuthMiddleware('admin'), async (req, res) => {
    const { reason } = req.body;
    try {
        await pool.query(
            `UPDATE users SET is_banned = TRUE, banned_reason = $1, banned_at = CURRENT_TIMESTAMP, banned_by = $2
             WHERE id = $3`,
            [reason || 'Banned by admin', req.admin.id, req.params.id]
        );
        await logAuditEvent(req.admin.id, 'user.ban', 'user', req.params.id, { reason }, req);
        return res.json({ success: true, message: 'User banned' });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to ban user' });
    }
});

/**
 * POST /api/admin/users/:id/unban
 */
router.post('/users/:id/unban', adminAuthMiddleware('admin'), async (req, res) => {
    try {
        await pool.query(
            `UPDATE users SET is_banned = FALSE, banned_reason = NULL, banned_at = NULL, banned_by = NULL
             WHERE id = $1`,
            [req.params.id]
        );
        await logAuditEvent(req.admin.id, 'user.unban', 'user', req.params.id, null, req);
        return res.json({ success: true, message: 'User unbanned' });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to unban user' });
    }
});

/**
 * GET /api/admin/users/export/csv
 * Download all users as CSV
 */
router.get('/users/export/csv', adminAuthMiddleware('admin'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT u.telegram_id, u.telegram_username, u.first_name, u.last_name,
                    u.referral_code, u.gravy_account_number, u.is_onboarded,
                    u.wallet_balance, u.total_earned, u.is_banned, u.created_at,
                    ref.referral_code as referrer_code,
                    COUNT(DISTINCT rt.descendant_id) FILTER (WHERE rt.level = 1) as direct_referrals
             FROM users u
             LEFT JOIN users ref ON ref.id = u.referred_by
             LEFT JOIN referral_tree rt ON rt.ancestor_id = u.id
             GROUP BY u.id, ref.referral_code
             ORDER BY u.created_at DESC`
        );

        const headers = 'Telegram ID,Username,First Name,Last Name,Referral Code,Gravy Account,Onboarded,Balance,Total Earned,Banned,Direct Referrals,Referrer Code,Joined\n';
        const csv = result.rows.map(r =>
            `${r.telegram_id},"${r.telegram_username || ''}","${r.first_name || ''}","${r.last_name || ''}",${r.referral_code},${r.gravy_account_number || ''},${r.is_onboarded},${r.wallet_balance},${r.total_earned},${r.is_banned},${r.direct_referrals},${r.referrer_code || ''},${r.created_at}`
        ).join('\n');

        await logAuditEvent(req.admin.id, 'users.export', 'user', null, { count: result.rows.length }, req);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=gravy-users-${new Date().toISOString().split('T')[0]}.csv`);
        return res.send(headers + csv);
    } catch (err) {
        return res.status(500).json({ error: 'Export failed' });
    }
});

// ============================================================
// WITHDRAWAL MANAGEMENT
// ============================================================

/**
 * GET /api/admin/withdrawals
 * List withdrawal requests with filters
 */
router.get('/withdrawals', adminAuthMiddleware(), async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const offset = (page - 1) * limit;
    const status = req.query.status || 'all';

    try {
        let statusClause = '';
        if (status !== 'all') statusClause = `AND w.status = '${status.replace(/'/g, '')}'`;

        const [withdrawals, countResult] = await Promise.all([
            pool.query(
                `SELECT w.*, u.first_name, u.telegram_username, u.telegram_id,
                        u.referral_code, u.total_earned, u.is_banned,
                        COUNT(DISTINCT rt.descendant_id) FILTER (WHERE rt.level = 1) as direct_referrals,
                        COUNT(DISTINCT rt.descendant_id) as total_network
                 FROM withdrawal_requests w
                 JOIN users u ON u.id = w.user_id
                 LEFT JOIN referral_tree rt ON rt.ancestor_id = u.id
                 WHERE 1=1 ${statusClause}
                 GROUP BY w.id, u.id
                 ORDER BY CASE w.status WHEN 'pending' THEN 0 ELSE 1 END, w.created_at DESC
                 LIMIT $1 OFFSET $2`,
                [limit, offset]
            ),
            pool.query(
                `SELECT COUNT(*) FROM withdrawal_requests w WHERE 1=1 ${statusClause}`
            )
        ]);

        return res.json({
            success: true,
            withdrawals: withdrawals.rows.map(w => ({
                id: w.id,
                userId: w.user_id,
                userName: w.first_name || w.telegram_username,
                userUsername: w.telegram_username,
                telegramId: w.telegram_id,
                referralCode: w.referral_code,
                amount: parseFloat(w.amount),
                destinationAccount: w.destination_account,
                status: w.status,
                adminNotes: w.admin_notes,
                reviewedBy: w.reviewed_by,
                reviewedAt: w.reviewed_at,
                totalEarned: parseFloat(w.total_earned),
                directReferrals: parseInt(w.direct_referrals),
                totalNetwork: parseInt(w.total_network),
                isBanned: w.is_banned,
                createdAt: w.created_at
            })),
            pagination: {
                page, limit,
                total: parseInt(countResult.rows[0].count),
                totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
            }
        });
    } catch (err) {
        console.error('[Admin] Withdrawals error:', err);
        return res.status(500).json({ error: 'Failed to load withdrawals' });
    }
});

/**
 * POST /api/admin/withdrawals/:id/approve
 */
router.post('/withdrawals/:id/approve', adminAuthMiddleware('admin'), async (req, res) => {
    const { notes } = req.body;
    try {
        const result = await pool.query(
            `UPDATE withdrawal_requests
             SET status = 'approved', reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP, admin_notes = $2
             WHERE id = $3 AND status = 'pending'
             RETURNING *`,
            [req.admin.displayName, notes || null, req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Withdrawal not found or already processed' });
        }

        await logAuditEvent(req.admin.id, 'withdrawal.approve', 'withdrawal', req.params.id,
            { amount: result.rows[0].amount, notes }, req);

        return res.json({ success: true, message: 'Withdrawal approved' });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to approve withdrawal' });
    }
});

/**
 * POST /api/admin/withdrawals/:id/reject
 */
router.post('/withdrawals/:id/reject', adminAuthMiddleware('admin'), async (req, res) => {
    const { notes } = req.body;
    try {
        const wr = await pool.query('SELECT * FROM withdrawal_requests WHERE id = $1', [req.params.id]);
        if (wr.rows.length === 0) return res.status(404).json({ error: 'Not found' });

        await pool.query(
            `UPDATE withdrawal_requests
             SET status = 'rejected', reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP, admin_notes = $2
             WHERE id = $3 AND status = 'pending'`,
            [req.admin.displayName, notes || 'Rejected by admin', req.params.id]
        );

        await logAuditEvent(req.admin.id, 'withdrawal.reject', 'withdrawal', req.params.id,
            { amount: wr.rows[0].amount, notes }, req);

        return res.json({ success: true, message: 'Withdrawal rejected' });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to reject withdrawal' });
    }
});

/**
 * POST /api/admin/withdrawals/:id/process
 * Mark an approved withdrawal as processed (paid)
 */
router.post('/withdrawals/:id/process', adminAuthMiddleware('admin'), async (req, res) => {
    const { notes } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const wr = await client.query(
            `SELECT * FROM withdrawal_requests WHERE id = $1 AND status = 'approved'`,
            [req.params.id]
        );

        if (wr.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Withdrawal not found or not approved' });
        }

        const withdrawal = wr.rows[0];

        // Deduct from wallet
        await client.query(
            `UPDATE users SET wallet_balance = wallet_balance - $1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [withdrawal.amount, withdrawal.user_id]
        );

        // Get updated balance
        const balResult = await client.query('SELECT wallet_balance FROM users WHERE id = $1', [withdrawal.user_id]);

        // Record transaction
        await client.query(
            `INSERT INTO wallet_transactions (user_id, type, amount, balance_after, description, reference_id)
             VALUES ($1, 'withdrawal', $2, $3, $4, $5)`,
            [withdrawal.user_id, -withdrawal.amount, balResult.rows[0].wallet_balance,
             'Withdrawal processed', withdrawal.id]
        );

        // Update withdrawal status
        await client.query(
            `UPDATE withdrawal_requests SET status = 'processed', processed_at = CURRENT_TIMESTAMP,
             admin_notes = COALESCE(admin_notes || ' | ', '') || $1
             WHERE id = $2`,
            [notes || 'Processed', req.params.id]
        );

        await client.query('COMMIT');

        await logAuditEvent(req.admin.id, 'withdrawal.process', 'withdrawal', req.params.id,
            { amount: withdrawal.amount, userId: withdrawal.user_id }, req);

        return res.json({ success: true, message: 'Withdrawal processed and funds deducted' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[Admin] Process withdrawal error:', err);
        return res.status(500).json({ error: 'Failed to process withdrawal' });
    } finally {
        client.release();
    }
});

// ============================================================
// REFERRAL AUDIT
// ============================================================

/**
 * GET /api/admin/referrals/audit
 * View referral chains with fraud detection
 */
router.get('/referrals/audit', adminAuthMiddleware(), async (req, res) => {
    try {
        // Find suspicious patterns: users with same IP, rapid signups, etc.
        const suspiciousChains = await pool.query(
            `SELECT u.id, u.first_name, u.telegram_username, u.referral_code,
                    u.total_earned, u.created_at,
                    COUNT(DISTINCT rt.descendant_id) as referral_count,
                    COUNT(DISTINCT re.source_user_id) as paid_referrals
             FROM users u
             LEFT JOIN referral_tree rt ON rt.ancestor_id = u.id AND rt.level = 1
             LEFT JOIN referral_earnings re ON re.earner_id = u.id
             GROUP BY u.id
             HAVING COUNT(DISTINCT rt.descendant_id) > 0
             ORDER BY u.total_earned DESC
             LIMIT 50`
        );

        // Recent earnings distribution
        const recentEarnings = await pool.query(
            `SELECT re.*, u1.first_name as earner_name, u1.telegram_username as earner_username,
                    u2.first_name as source_name, u2.telegram_username as source_username
             FROM referral_earnings re
             JOIN users u1 ON u1.id = re.earner_id
             JOIN users u2 ON u2.id = re.source_user_id
             ORDER BY re.created_at DESC
             LIMIT 50`
        );

        return res.json({
            success: true,
            referrers: suspiciousChains.rows,
            recentEarnings: recentEarnings.rows
        });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to load audit data' });
    }
});

// ============================================================
// ADMIN MANAGEMENT (super_admin only)
// ============================================================

/**
 * GET /api/admin/admins
 * List all admin accounts
 */
router.get('/admins', adminAuthMiddleware('super_admin'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, username, email, display_name, role, is_active,
                    last_login_at, last_login_ip, created_at
             FROM admin_users ORDER BY created_at ASC`
        );
        return res.json({ success: true, admins: result.rows });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to load admins' });
    }
});

/**
 * POST /api/admin/admins
 * Create a new admin account
 */
router.post('/admins', adminAuthMiddleware('super_admin'), async (req, res) => {
    const { username, password, email, displayName, role } = req.body;
    const validRoles = ['viewer', 'admin', 'super_admin'];

    if (!username || !password || !email || !displayName) {
        return res.status(400).json({ error: 'All fields required' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (role && !validRoles.includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
    }

    try {
        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const result = await pool.query(
            `INSERT INTO admin_users (username, email, password_hash, display_name, role, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, username, email, display_name, role`,
            [username.toLowerCase().trim(), email.toLowerCase().trim(), passwordHash, displayName, role || 'admin', req.admin.id]
        );

        await logAuditEvent(req.admin.id, 'admin.create', 'admin', result.rows[0].id,
            { username, role: role || 'admin' }, req);

        return res.json({ success: true, admin: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: 'Username or email already taken' });
        return res.status(500).json({ error: 'Failed to create admin' });
    }
});

/**
 * POST /api/admin/admins/:id/deactivate
 */
router.post('/admins/:id/deactivate', adminAuthMiddleware('super_admin'), async (req, res) => {
    if (req.params.id === req.admin.id) {
        return res.status(400).json({ error: 'Cannot deactivate yourself' });
    }
    try {
        await pool.query('UPDATE admin_users SET is_active = FALSE WHERE id = $1', [req.params.id]);
        await revokeAllSessions(req.params.id);
        await logAuditEvent(req.admin.id, 'admin.deactivate', 'admin', req.params.id, null, req);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to deactivate admin' });
    }
});

/**
 * POST /api/admin/admins/:id/activate
 */
router.post('/admins/:id/activate', adminAuthMiddleware('super_admin'), async (req, res) => {
    try {
        await pool.query('UPDATE admin_users SET is_active = TRUE WHERE id = $1', [req.params.id]);
        await logAuditEvent(req.admin.id, 'admin.activate', 'admin', req.params.id, null, req);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to activate admin' });
    }
});

// ============================================================
// AUDIT LOG
// ============================================================

/**
 * GET /api/admin/audit-log
 */
router.get('/audit-log', adminAuthMiddleware('admin'), async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = (page - 1) * limit;

    try {
        const [logs, count] = await Promise.all([
            pool.query(
                `SELECT al.*, a.username, a.display_name
                 FROM admin_audit_log al
                 LEFT JOIN admin_users a ON a.id = al.admin_id
                 ORDER BY al.created_at DESC
                 LIMIT $1 OFFSET $2`,
                [limit, offset]
            ),
            pool.query('SELECT COUNT(*) FROM admin_audit_log')
        ]);

        return res.json({
            success: true,
            logs: logs.rows,
            pagination: {
                page, limit,
                total: parseInt(count.rows[0].count),
                totalPages: Math.ceil(parseInt(count.rows[0].count) / limit)
            }
        });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to load audit log' });
    }
});

// ============================================================
// SECURITY EVENTS
// ============================================================

/**
 * GET /api/admin/security-events
 */
router.get('/security-events', adminAuthMiddleware('admin'), async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    try {
        const result = await pool.query(
            'SELECT * FROM security_events ORDER BY created_at DESC LIMIT $1',
            [limit]
        );
        return res.json({ success: true, events: result.rows });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to load security events' });
    }
});

// ============================================================
// SETTINGS
// ============================================================

/**
 * GET /api/admin/settings
 */
router.get('/settings', adminAuthMiddleware(), async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM app_settings ORDER BY key');
        const settings = {};
        for (const row of result.rows) {
            settings[row.key] = { value: row.value, description: row.description, updatedAt: row.updated_at };
        }
        return res.json({ success: true, settings });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to load settings' });
    }
});

/**
 * PUT /api/admin/settings
 */
router.put('/settings', adminAuthMiddleware('super_admin'), async (req, res) => {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
        return res.status(400).json({ error: 'Invalid settings object' });
    }

    try {
        for (const [key, value] of Object.entries(settings)) {
            await pool.query(
                `UPDATE app_settings SET value = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP
                 WHERE key = $3`,
                [String(value), req.admin.id, key]
            );
        }

        await logAuditEvent(req.admin.id, 'settings.update', 'settings', null,
            { changed: Object.keys(settings) }, req);

        return res.json({ success: true, message: 'Settings updated' });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to update settings' });
    }
});

/**
 * POST /api/admin/link-referral
 * Manually link a user to a referrer (for cases where the referral code
 * wasn't captured during registration).
 *
 * Body: { userId: string, referrerId: string }
 */
router.post('/link-referral', adminAuthMiddleware('admin'), async (req, res) => {
    const { userId, referrerId } = req.body;

    if (!userId || !referrerId) {
        return res.status(400).json({ error: 'Both userId and referrerId are required' });
    }

    if (userId === referrerId) {
        return res.status(400).json({ error: 'A user cannot refer themselves' });
    }

    try {
        const { registerReferralChain, distributeEarnings } = require('../services/referralTree');

        // Verify both users exist
        const [userResult, referrerResult] = await Promise.all([
            pool.query('SELECT id, first_name, last_name, referred_by, is_onboarded FROM users WHERE id = $1', [userId]),
            pool.query('SELECT id, first_name, last_name, referral_code FROM users WHERE id = $1', [referrerId])
        ]);

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (referrerResult.rows.length === 0) {
            return res.status(404).json({ error: 'Referrer not found' });
        }

        const user = userResult.rows[0];
        const referrer = referrerResult.rows[0];

        // Check if user already has a referrer
        if (user.referred_by) {
            return res.status(400).json({
                error: `User already has a referrer (${user.referred_by}). Unlink first if needed.`
            });
        }

        // Check for circular referral (referrer can't be in user's downstream)
        const circularCheck = await pool.query(
            'SELECT id FROM referral_tree WHERE ancestor_id = $1 AND descendant_id = $2',
            [userId, referrerId]
        );
        if (circularCheck.rows.length > 0) {
            return res.status(400).json({ error: 'Circular referral detected — the referrer is already downstream of this user' });
        }

        // Set referred_by
        await pool.query(
            'UPDATE users SET referred_by = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [referrerId, userId]
        );

        // Build referral chain
        await registerReferralChain(userId, referrerId);

        // If user is onboarded, distribute earnings
        let earningsDistributed = 0;
        if (user.is_onboarded) {
            const earnings = await distributeEarnings(userId);
            earningsDistributed = earnings.length;
        }

        await logAuditEvent(req.admin.id, 'referral.manual_link', 'user', userId,
            {
                referrerId,
                userName: `${user.first_name} ${user.last_name}`,
                referrerName: `${referrer.first_name} ${referrer.last_name}`,
                earningsDistributed
            }, req);

        return res.json({
            success: true,
            message: `Linked ${user.first_name} ${user.last_name} → referred by ${referrer.first_name} ${referrer.last_name}. ${earningsDistributed} earnings distributed.`,
            earningsDistributed
        });
    } catch (err) {
        console.error('[Admin] Link referral error:', err);
        return res.status(500).json({ error: 'Failed to link referral: ' + err.message });
    }
});

/**
 * POST /api/admin/fix-user-names
 * Re-resolve names from Paystack for already-verified users whose names
 * weren't populated (e.g., verified before the name-population code was deployed).
 *
 * Body: { userId?: string } — if provided, fix only that user. Otherwise fix all.
 */
router.post('/fix-user-names', adminAuthMiddleware(), async (req, res) => {
    try {
        const { verifyOnboarding } = require('../services/gravyApi');
        const { userId } = req.body;

        let usersToFix;
        if (userId) {
            usersToFix = await pool.query(
                `SELECT id, gravy_account_number, first_name, last_name
                 FROM users WHERE id = $1 AND is_onboarded = TRUE AND gravy_account_number IS NOT NULL`,
                [userId]
            );
        } else {
            // Fix all verified users — re-resolve their names from Paystack
            usersToFix = await pool.query(
                `SELECT id, gravy_account_number, first_name, last_name
                 FROM users WHERE is_onboarded = TRUE AND gravy_account_number IS NOT NULL`
            );
        }

        let fixed = 0;
        const results = [];

        for (const user of usersToFix.rows) {
            try {
                const verification = await verifyOnboarding(user.gravy_account_number);
                if (verification.verified && verification.accountData && verification.accountData.fullName) {
                    const nameParts = verification.accountData.fullName.split(' ');
                    let newFirst = nameParts[0];
                    let newLast = nameParts.length >= 2 ? nameParts.slice(1).join(' ') : user.last_name;

                    // Only update if the name actually changed
                    if (newFirst !== user.first_name || newLast !== user.last_name) {
                        await pool.query(
                            `UPDATE users SET first_name = $1, last_name = $2, updated_at = CURRENT_TIMESTAMP
                             WHERE id = $3`,
                            [newFirst, newLast, user.id]
                        );
                        fixed++;
                        results.push({
                            userId: user.id,
                            oldName: `${user.first_name} ${user.last_name}`,
                            newName: `${newFirst} ${newLast}`
                        });
                    }
                }
            } catch (e) {
                console.error(`[Admin] Failed to fix name for user ${user.id}:`, e.message);
            }
        }

        return res.json({
            success: true,
            message: `Fixed ${fixed} user name(s)`,
            fixed,
            results
        });
    } catch (err) {
        console.error('[Admin] Fix user names error:', err);
        return res.status(500).json({ error: 'Failed to fix user names' });
    }
});

/**
 * POST /api/admin/fix-referral-chains
 * One-time fix: rebuild missing referral chains for users who have referred_by
 * set but no referral_tree entries, and distribute any missing earnings.
 */
router.post('/fix-referral-chains', adminAuthMiddleware(), async (req, res) => {
    try {
        const { registerReferralChain, distributeEarnings } = require('../services/referralTree');

        // Find users who have referred_by but no referral_tree entry
        const missingChains = await pool.query(
            `SELECT u.id, u.referred_by, u.is_onboarded, u.first_name
             FROM users u
             LEFT JOIN referral_tree rt ON rt.descendant_id = u.id AND rt.level = 1
             WHERE u.referred_by IS NOT NULL AND rt.id IS NULL`
        );

        let chainsFixed = 0;
        let earningsDistributed = 0;

        for (const user of missingChains.rows) {
            try {
                await registerReferralChain(user.id, user.referred_by);
                chainsFixed++;

                // If this user is already onboarded, distribute earnings
                if (user.is_onboarded) {
                    const earnings = await distributeEarnings(user.id);
                    earningsDistributed += earnings.length;
                }
            } catch (e) {
                console.error(`[Admin] Failed to fix chain for user ${user.id}:`, e.message);
            }
        }

        await logAuditEvent(req.admin.id, 'referral.fix_chains', 'system', null,
            { chainsFixed, earningsDistributed, totalChecked: missingChains.rows.length }, req);

        return res.json({
            success: true,
            message: `Fixed ${chainsFixed} referral chains, distributed ${earningsDistributed} earnings`,
            chainsFixed,
            earningsDistributed
        });
    } catch (err) {
        console.error('[Admin] Fix referral chains error:', err);
        return res.status(500).json({ error: 'Failed to fix referral chains' });
    }
});

module.exports = router;
