-- ============================================================
-- GRAVY REFERRAL PROGRAMME - DATABASE SCHEMA
-- Multi-level referral system (3 levels deep)
-- Level 1: ₦200 | Level 2: ₦50 | Level 3: ₦10
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- USERS TABLE
-- Core user table linked to Telegram identity
-- ============================================================
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    telegram_id BIGINT UNIQUE NOT NULL,
    telegram_username VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    phone_number VARCHAR(20),

    -- Gravy onboarding fields
    gravy_account_number VARCHAR(50) UNIQUE,  -- Virtual account from Gravy
    is_onboarded BOOLEAN DEFAULT FALSE,        -- Has completed Gravy onboarding
    onboarding_verified_at TIMESTAMP,          -- When verification was confirmed via API

    -- Referral fields
    referral_code VARCHAR(10) UNIQUE NOT NULL,  -- This user's unique referral code
    referred_by UUID REFERENCES users(id),      -- Who referred this user (Level 1 parent)
    referral_depth INTEGER DEFAULT 0,           -- How deep in the tree this user sits

    -- Wallet
    wallet_balance DECIMAL(12, 2) DEFAULT 0.00,
    total_earned DECIMAL(12, 2) DEFAULT 0.00,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- REFERRAL_TREE TABLE
-- Denormalized referral chain for fast lookups
-- Each row = one ancestor-descendant relationship
-- ============================================================
CREATE TABLE referral_tree (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ancestor_id UUID NOT NULL REFERENCES users(id),     -- The person who earns
    descendant_id UUID NOT NULL REFERENCES users(id),   -- The person who was referred
    level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 3), -- 1=direct, 2=indirect, 3=deep
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(ancestor_id, descendant_id)
);

-- ============================================================
-- REFERRAL_EARNINGS TABLE
-- Ledger of all earnings from referrals
-- ============================================================
CREATE TABLE referral_earnings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    earner_id UUID NOT NULL REFERENCES users(id),        -- Who earned the money
    source_user_id UUID NOT NULL REFERENCES users(id),   -- Who triggered the earning (the new user)
    level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 3),
    amount DECIMAL(10, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'credited',  -- credited, pending, reversed
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- WALLET_TRANSACTIONS TABLE
-- Full transaction history for each user's wallet
-- ============================================================
CREATE TABLE wallet_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    type VARCHAR(30) NOT NULL,  -- 'referral_earning', 'withdrawal', 'bonus', 'reversal'
    amount DECIMAL(10, 2) NOT NULL,  -- Positive for credit, negative for debit
    balance_after DECIMAL(12, 2) NOT NULL,
    description TEXT,
    reference_id UUID,  -- Links to referral_earnings.id or other source
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- WITHDRAWAL_REQUESTS TABLE
-- When/if you add withdrawal capability later
-- ============================================================
CREATE TABLE withdrawal_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    amount DECIMAL(10, 2) NOT NULL,
    destination_account VARCHAR(50) NOT NULL,  -- Gravy virtual account
    status VARCHAR(20) DEFAULT 'pending',  -- pending, approved, processed, rejected
    reviewed_by VARCHAR(100),
    reviewed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- ONBOARDING_VERIFICATIONS TABLE
-- Log of all API verification attempts
-- ============================================================
CREATE TABLE onboarding_verifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    gravy_account_number VARCHAR(50),
    api_response_status VARCHAR(20),  -- success, failed, error
    api_response_body JSONB,
    verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- INDEXES for performance
-- ============================================================
CREATE INDEX idx_users_telegram_id ON users(telegram_id);
CREATE INDEX idx_users_referral_code ON users(referral_code);
CREATE INDEX idx_users_referred_by ON users(referred_by);
CREATE INDEX idx_users_is_onboarded ON users(is_onboarded);
CREATE INDEX idx_referral_tree_ancestor ON referral_tree(ancestor_id);
CREATE INDEX idx_referral_tree_descendant ON referral_tree(descendant_id);
CREATE INDEX idx_referral_tree_level ON referral_tree(level);
CREATE INDEX idx_earnings_earner ON referral_earnings(earner_id);
CREATE INDEX idx_earnings_source ON referral_earnings(source_user_id);
CREATE INDEX idx_wallet_tx_user ON wallet_transactions(user_id);
CREATE INDEX idx_withdrawal_user ON withdrawal_requests(user_id);

-- ============================================================
-- LEADERBOARD VIEW
-- Pre-computed view for fast leaderboard queries
-- ============================================================
CREATE OR REPLACE VIEW leaderboard AS
SELECT
    u.id,
    u.telegram_username,
    u.first_name,
    u.last_name,
    u.total_earned,
    u.wallet_balance,
    COUNT(DISTINCT rt.descendant_id) FILTER (WHERE rt.level = 1) AS direct_referrals,
    COUNT(DISTINCT rt.descendant_id) AS total_network_size,
    RANK() OVER (ORDER BY u.total_earned DESC) AS rank
FROM users u
LEFT JOIN referral_tree rt ON rt.ancestor_id = u.id
WHERE u.is_onboarded = TRUE
GROUP BY u.id, u.telegram_username, u.first_name, u.last_name, u.total_earned, u.wallet_balance
ORDER BY u.total_earned DESC;
