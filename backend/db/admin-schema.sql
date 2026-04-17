-- ============================================================
-- GRAVY REFERRAL PROGRAMME - ADMIN PANEL SCHEMA
-- Multi-admin support with security hardening
-- ============================================================

-- ============================================================
-- ADMIN_USERS TABLE
-- Supports multiple admin accounts with roles
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,       -- bcrypt hash
    display_name VARCHAR(100) NOT NULL,
    role VARCHAR(20) DEFAULT 'admin',          -- super_admin, admin, viewer
    is_active BOOLEAN DEFAULT TRUE,
    last_login_at TIMESTAMP,
    last_login_ip VARCHAR(45),
    failed_login_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMP,                    -- Account lockout after failed attempts
    password_changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID REFERENCES admin_users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- ADMIN_SESSIONS TABLE
-- Secure session management with expiry
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    admin_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) UNIQUE NOT NULL,   -- SHA-256 hash of session token
    ip_address VARCHAR(45),
    user_agent TEXT,
    expires_at TIMESTAMP NOT NULL,
    is_revoked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- ADMIN_AUDIT_LOG TABLE
-- Tracks every admin action for accountability
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    admin_id UUID REFERENCES admin_users(id),
    action VARCHAR(100) NOT NULL,              -- e.g. 'withdrawal.approve', 'user.ban'
    resource_type VARCHAR(50),                 -- e.g. 'withdrawal', 'user'
    resource_id VARCHAR(255),                  -- ID of the affected resource
    details JSONB,                             -- Additional context
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- SECURITY_EVENTS TABLE
-- Logs security-relevant events (failed logins, etc.)
-- ============================================================
CREATE TABLE IF NOT EXISTS security_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type VARCHAR(50) NOT NULL,           -- 'login_failed', 'account_locked', 'suspicious_activity'
    ip_address VARCHAR(45),
    username VARCHAR(100),
    details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- IP_BLACKLIST TABLE
-- Permanently or temporarily block IPs
-- ============================================================
CREATE TABLE IF NOT EXISTS ip_blacklist (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ip_address VARCHAR(45) UNIQUE NOT NULL,
    reason TEXT,
    blocked_by UUID REFERENCES admin_users(id),
    expires_at TIMESTAMP,                      -- NULL = permanent
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- APP_SETTINGS TABLE
-- Configurable settings for the referral system
-- ============================================================
CREATE TABLE IF NOT EXISTS app_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_by UUID REFERENCES admin_users(id),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- Add is_banned column to users if not exists
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='users' AND column_name='is_banned') THEN
        ALTER TABLE users ADD COLUMN is_banned BOOLEAN DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='users' AND column_name='banned_reason') THEN
        ALTER TABLE users ADD COLUMN banned_reason TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='users' AND column_name='banned_at') THEN
        ALTER TABLE users ADD COLUMN banned_at TIMESTAMP;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='users' AND column_name='banned_by') THEN
        ALTER TABLE users ADD COLUMN banned_by UUID;
    END IF;
    -- Add admin notes to withdrawal_requests
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='withdrawal_requests' AND column_name='admin_notes') THEN
        ALTER TABLE withdrawal_requests ADD COLUMN admin_notes TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='withdrawal_requests' AND column_name='processed_at') THEN
        ALTER TABLE withdrawal_requests ADD COLUMN processed_at TIMESTAMP;
    END IF;
END $$;

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_admin ON admin_audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_security_events_ip ON security_events(ip_address);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type);
CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at);
CREATE INDEX IF NOT EXISTS idx_ip_blacklist_ip ON ip_blacklist(ip_address);
CREATE INDEX IF NOT EXISTS idx_users_is_banned ON users(is_banned);

-- ============================================================
-- DEFAULT SETTINGS
-- ============================================================
INSERT INTO app_settings (key, value, description) VALUES
    ('level_1_earning', '200', 'Earning per Level 1 (direct) referral in Naira'),
    ('level_2_earning', '50', 'Earning per Level 2 referral in Naira'),
    ('level_3_earning', '10', 'Earning per Level 3 referral in Naira'),
    ('min_withdrawal', '500', 'Minimum withdrawal amount in Naira'),
    ('withdrawals_enabled', 'true', 'Whether withdrawals are currently enabled'),
    ('referrals_enabled', 'true', 'Whether new referral signups are enabled'),
    ('maintenance_mode', 'false', 'Whether the system is in maintenance mode')
ON CONFLICT (key) DO NOTHING;
