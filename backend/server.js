/**
 * Gravy Referral Programme - API Server
 *
 * Express.js backend powering the Telegram Mini App
 * for the Gravy Mobile multi-level referral system.
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
// MIDDLEWARE
// ============================================================

// Security headers
app.use(helmet({
    contentSecurityPolicy: false  // Relaxed for Telegram WebApp
}));

// CORS — allow Telegram's domains
app.use(cors({
    origin: [
        'https://web.telegram.org',
        'https://telegram.org',
        process.env.WEBAPP_URL
    ].filter(Boolean),
    credentials: true
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: 100,                   // 100 requests per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' }
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
// SERVE FRONTEND (Telegram Mini App)
// ============================================================
app.use(express.static(path.join(__dirname, '../frontend')));

// ============================================================
// API ROUTES
// ============================================================
app.use('/api/auth', require('./routes/auth'));
app.use('/api/referral', require('./routes/referral'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/leaderboard', require('./routes/leaderboard'));

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
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: 'Something went wrong. Please try again later.'
    });
});

// 404 handler for API routes
app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
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
    ╚══════════════════════════════════════════╝
    `);
});
});

module.exports = app;
