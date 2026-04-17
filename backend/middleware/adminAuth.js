/**
 * Admin Authentication Middleware
 *
 * Handles admin session validation, brute-force protection,
 * IP blacklisting, and audit logging.
 */

const crypto = require('crypto');
const pool = require('../db/pool');

// ============================================================
// CONSTANTS
// ============================================================
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 30;
const SESSION_DURATION_HOURS = 8;
const MAX_SESSIONS_PER_ADMIN = 3;

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

/**
 * Hash a session token using SHA-256
 */
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a cryptographically secure session token
 */
function generateSessionToken() {
    return crypto.randomBytes(48).toString('hex');
}

/**
 * Get client IP address (handles proxies)
 */
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.headers['x-real-ip']
        || req.connection?.remoteAddress
        || req.ip
        || 'unknown';
}

// ============================================================
// IP BLACKLIST CHECK
// ============================================================
async function isIPBlacklisted(ip) {
    try {
        const result = await pool.query(
            `SELECT id FROM ip_blacklist
             WHERE ip_address = $1
             AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`,
            [ip]
        );
        return result.rows.length > 0;
    } catch {
        return false;
    }
}

// ============================================================
// BRUTE-FORCE PROTECTION
// ============================================================
async function checkBruteForce(ip) {
    try {
        // Count failed login attempts from this IP in the last 30 minutes
        const result = await pool.query(
            `SELECT COUNT(*) as count FROM security_events
             WHERE ip_address = $1
             AND event_type = 'login_failed'
             AND created_at > CURRENT_TIMESTAMP - INTERVAL '30 minutes'`,
            [ip]
        );
        const failedCount = parseInt(result.rows[0].count);

        // Auto-blacklist IP after 20 failed attempts in 30 mins
        if (failedCount >= 20) {
            await pool.query(
                `INSERT INTO ip_blacklist (ip_address, reason, expires_at)
                 VALUES ($1, 'Automated: excessive failed login attempts', CURRENT_TIMESTAMP + INTERVAL '24 hours')
                 ON CONFLICT (ip_address) DO UPDATE SET expires_at = CURRENT_TIMESTAMP + INTERVAL '24 hours'`,
                [ip]
            );
            return { blocked: true, reason: 'IP temporarily blocked due to excessive failed attempts' };
        }

        if (failedCount >= 10) {
            return { blocked: true, reason: 'Too many failed attempts. Please wait 30 minutes.' };
        }

        return { blocked: false };
    } catch {
        return { blocked: false };
    }
}

// ============================================================
// AUDIT LOGGING
// ============================================================
async function logAuditEvent(adminId, action, resourceType, resourceId, details, req) {
    try {
        await pool.query(
            `INSERT INTO admin_audit_log (admin_id, action, resource_type, resource_id, details, ip_address, user_agent)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                adminId,
                action,
                resourceType,
                resourceId,
                details ? JSON.stringify(details) : null,
                getClientIP(req),
                req.headers['user-agent'] || null
            ]
        );
    } catch (err) {
        console.error('[Audit] Failed to log event:', err.message);
    }
}

/**
 * Log a security event
 */
async function logSecurityEvent(eventType, ip, username, details) {
    try {
        await pool.query(
            `INSERT INTO security_events (event_type, ip_address, username, details)
             VALUES ($1, $2, $3, $4)`,
            [eventType, ip, username, details ? JSON.stringify(details) : null]
        );
    } catch (err) {
        console.error('[Security] Failed to log event:', err.message);
    }
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

/**
 * Create a new admin session
 */
async function createSession(adminId, req) {
    const token = generateSessionToken();
    const tokenHash = hashToken(token);
    const ip = getClientIP(req);
    const userAgent = req.headers['user-agent'] || '';
    const expiresAt = new Date(Date.now() + SESSION_DURATION_HOURS * 60 * 60 * 1000);

    // Enforce max sessions — revoke oldest if exceeded
    const activeSessions = await pool.query(
        `SELECT id FROM admin_sessions
         WHERE admin_id = $1 AND is_revoked = FALSE AND expires_at > CURRENT_TIMESTAMP
         ORDER BY created_at ASC`,
        [adminId]
    );

    if (activeSessions.rows.length >= MAX_SESSIONS_PER_ADMIN) {
        const oldest = activeSessions.rows[0];
        await pool.query(
            'UPDATE admin_sessions SET is_revoked = TRUE WHERE id = $1',
            [oldest.id]
        );
    }

    await pool.query(
        `INSERT INTO admin_sessions (admin_id, token_hash, ip_address, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [adminId, tokenHash, ip, userAgent, expiresAt]
    );

    // Update last login
    await pool.query(
        `UPDATE admin_users SET last_login_at = CURRENT_TIMESTAMP, last_login_ip = $1,
         failed_login_attempts = 0 WHERE id = $2`,
        [ip, adminId]
    );

    return { token, expiresAt };
}

/**
 * Validate a session token and return the admin user
 */
async function validateSession(token) {
    const tokenHash = hashToken(token);

    const result = await pool.query(
        `SELECT s.*, a.id as admin_id, a.username, a.email, a.display_name, a.role, a.is_active
         FROM admin_sessions s
         JOIN admin_users a ON a.id = s.admin_id
         WHERE s.token_hash = $1
         AND s.is_revoked = FALSE
         AND s.expires_at > CURRENT_TIMESTAMP
         AND a.is_active = TRUE`,
        [tokenHash]
    );

    if (result.rows.length === 0) return null;
    return result.rows[0];
}

/**
 * Revoke a session (logout)
 */
async function revokeSession(token) {
    const tokenHash = hashToken(token);
    await pool.query(
        'UPDATE admin_sessions SET is_revoked = TRUE WHERE token_hash = $1',
        [tokenHash]
    );
}

/**
 * Revoke all sessions for an admin (force logout everywhere)
 */
async function revokeAllSessions(adminId) {
    await pool.query(
        'UPDATE admin_sessions SET is_revoked = TRUE WHERE admin_id = $1',
        [adminId]
    );
}

// ============================================================
// MIDDLEWARE
// ============================================================

/**
 * Admin authentication middleware
 * Checks session token from Authorization header or cookie
 */
function adminAuthMiddleware(requiredRole = null) {
    return async (req, res, next) => {
        const ip = getClientIP(req);

        // 1. Check IP blacklist
        if (await isIPBlacklisted(ip)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // 2. Extract token
        const authHeader = req.headers['authorization'];
        let token = null;

        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.substring(7);
        } else if (req.cookies?.admin_session) {
            token = req.cookies.admin_session;
        }

        if (!token) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        // 3. Validate session
        try {
            const session = await validateSession(token);

            if (!session) {
                return res.status(401).json({ error: 'Invalid or expired session' });
            }

            // 4. Check role if required
            if (requiredRole) {
                const roleHierarchy = { viewer: 1, admin: 2, super_admin: 3 };
                const userLevel = roleHierarchy[session.role] || 0;
                const requiredLevel = roleHierarchy[requiredRole] || 0;

                if (userLevel < requiredLevel) {
                    await logAuditEvent(
                        session.admin_id, 'access_denied', null, null,
                        { requiredRole, userRole: session.role, path: req.path }, req
                    );
                    return res.status(403).json({ error: 'Insufficient permissions' });
                }
            }

            // 5. Attach admin to request
            req.admin = {
                id: session.admin_id,
                username: session.username,
                email: session.email,
                displayName: session.display_name,
                role: session.role
            };
            req.sessionToken = token;

            next();
        } catch (err) {
            console.error('[AdminAuth] Error:', err);
            return res.status(500).json({ error: 'Authentication error' });
        }
    };
}

// ============================================================
// CLEANUP - Remove expired sessions periodically
// ============================================================
async function cleanupExpiredSessions() {
    try {
        await pool.query(
            'DELETE FROM admin_sessions WHERE expires_at < CURRENT_TIMESTAMP OR is_revoked = TRUE'
        );
    } catch (err) {
        console.error('[AdminAuth] Cleanup error:', err.message);
    }
}

// Run cleanup every hour
setInterval(cleanupExpiredSessions, 60 * 60 * 1000);

module.exports = {
    adminAuthMiddleware,
    createSession,
    validateSession,
    revokeSession,
    revokeAllSessions,
    logAuditEvent,
    logSecurityEvent,
    checkBruteForce,
    isIPBlacklisted,
    getClientIP,
    hashToken,
    generateSessionToken,
    MAX_FAILED_ATTEMPTS,
    LOCKOUT_DURATION_MINUTES
};
