/**
 * Gravy Referral Programme - API Server
 *
 * Express.js backend powering the Telegram Mini App
 * for the Gravy Mobile multi-level referral system.
 *
 * Security hardened with:
 * - Helmet (security headers)
 * - CORS whitelist
 * - Rate limiting (tiered)
 * - Request size limits
 * - XSS protection
 * - SQL injection prevention (parameterized queries)
 * - Admin brute-force protection
 * - IP blacklisting
 * - Audit logging
 * - HTTPS-only cookies
 * - No server fingerprinting
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const pool = require('./db/pool');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// SECURITY: Remove server fingerprint
// ============================================================
app.disable('x-powered-by');

// ============================================================
// SECURITY: Helmet - comprehensive HTTP security headers
// ============================================================
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://telegram.org", "https://cdnjs.cloudflare.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "https://api.telegram.org"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: false,  // Allow Telegram WebApp embedding
    crossOriginOpenerPolicy: false,
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    xContentTypeOptions: true,         // Prevent MIME sniffing
    xFrameOptions: false               // Handled by CSP
}));

// ============================================================
// SECURITY: CORS whitelist
// ============================================================
app.use(cors({
    origin: [
        'https://web.telegram.org',
        'https://telegram.org',
        process.env.WEBAPP_URL
    ].filter(Boolean),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Telegram-Init-Data'],
    maxAge: 86400  // Cache preflight for 24 hours
}));

// ============================================================
// SECURITY: Rate limiting (tiered)
// ============================================================

// General API rate limit
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' },
    keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip
});

// Strict rate limit for auth endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,                   // 30 login attempts per 15 min
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please try again later.' },
    keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip
});

// Withdrawal rate limit
const withdrawalLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,  // 1 hour
    max: 5,                     // 5 withdrawal requests per hour
    message: { error: 'Withdrawal request limit reached. Try again later.' },
    keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip
});

app.use('/api/', generalLimiter);
app.use('/api/admin/auth/login', authLimiter);
app.use('/api/wallet/withdraw', withdrawalLimiter);

// ============================================================
// SECURITY: Body parsing with strict limits
// ============================================================
app.use(express.json({ limit: '100kb' }));     // Reduced from 1mb
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// ============================================================
// SECURITY: Request sanitization
// ============================================================
app.use((req, res, next) => {
    // Block requests with suspicious patterns
    const suspicious = /(\.\.|%00|%0d|%0a|<script|javascript:|data:text\/html)/i;
    const fullUrl = req.originalUrl + JSON.stringify(req.body || '');

    if (suspicious.test(fullUrl)) {
        console.warn(`[Security] Blocked suspicious request from ${req.ip}: ${req.originalUrl}`);
        return res.status(400).json({ error: 'Bad request' });
    }

    // Add security response headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    next();
});

// ============================================================
// SERVE FRONTEND (Telegram Mini App)
// ============================================================
app.use(express.static(path.join(__dirname, '../frontend'), {
    dotfiles: 'deny',       // Block hidden files
    index: 'index.html',
    maxAge: '1h'
}));

// Serve admin frontend
app.use('/admin', express.static(path.join(__dirname, '../frontend/admin'), {
    dotfiles: 'deny',
    index: 'index.html',
    maxAge: '1h'
}));

// ============================================================
// API ROUTES
// ============================================================
app.use('/api/auth', require('./routes/auth'));
app.use('/api/referral', require('./routes/referral'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/leaderboard', require('./routes/leaderboard'));
app.use('/api/admin', require('./routes/admin'));

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'gravy-referral-api',
        timestamp: new Date().toISOString()
    });
});

// ============================================================
// ERROR HANDLING
// ============================================================
app.use((err, req, res, next) => {
    // Don't leak error details in production
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: 'Something went wrong. Please try again later.'
    });
});

// 404 handler for API routes
app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Admin SPA fallback
app.get('/admin/*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/admin/index.html'));
});

// All other routes serve the Mini App
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ============================================================
// AUTO-INITIALIZE DATABASE ON FIRST START
// ============================================================
async function initDbIfNeeded() {
    try {
        await pool.query('SELECT 1 FROM users LIMIT 1');
        console.log('✅ Database tables already exist');
    } catch (err) {
        console.log('🗄️  First run detected — creating database tables...');
        try {
            const schema = fs.readFileSync(
                path.join(__dirname, 'db/schema.sql'), 'utf8'
            );
            await pool.query(schema);
            console.log('✅ Database tables created successfully!');
        } catch (initErr) {
            console.error('❌ Database init failed:', initErr.message);
        }
    }

    // Always run admin schema (uses IF NOT EXISTS)
    try {
        const adminSchema = fs.readFileSync(
            path.join(__dirname, 'db/admin-schema.sql'), 'utf8'
        );
        await pool.query(adminSchema);
        console.log('✅ Admin tables ready');
    } catch (adminErr) {
        console.error('⚠️  Admin schema error:', adminErr.message);
    }
}

// ============================================================
// START SERVER
// ============================================================
initDbIfNeeded().then(() => {
app.listen(PORT, () => {
    console.log(`
    ╔══════════════════════════════════════════╗
    ║   GRAVY REFERRAL PROGRAMME API SERVER    ║
    ║──────────────────────────────────────────║
    ║   Port: ${PORT}                              ║
    ║   Environment: ${process.env.NODE_ENV || 'development'}             ║
    ║   Admin Panel: /admin                    ║
    ║   Security: HARDENED                     ║
    ╚══════════════════════════════════════════╝
    `);
});
});

module.exports = app;
