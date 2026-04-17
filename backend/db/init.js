/**
 * Database Initialization Script
 * Run with: npm run db:init
 *
 * Creates all tables, indexes, and views for the Gravy Referral Programme.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function initDatabase() {
    const client = await pool.connect();

    try {
        console.log('🚀 Initializing Gravy Referral database...\n');

        const schema = fs.readFileSync(
            path.join(__dirname, 'schema.sql'),
            'utf8'
        );

        await client.query(schema);

        console.log('✅ Database schema created successfully!');
        console.log('   - users table');
        console.log('   - referral_tree table');
        console.log('   - referral_earnings table');
        console.log('   - wallet_transactions table');
        console.log('   - withdrawal_requests table');
        console.log('   - onboarding_verifications table');
        console.log('   - leaderboard view');
        console.log('   - All indexes created');
        console.log('\n🎉 Database is ready!');

    } catch (error) {
        console.error('❌ Database initialization failed:', error.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

initDatabase();
