/**
 * Gravy Onboarding API Service
 *
 * Communicates with Gravy Mobile's API to verify
 * that a user has completed their onboarding.
 *
 * IMPORTANT: Update the API endpoints and authentication
 * to match Gravy's actual API specification.
 */

const axios = require('axios');

const gravyClient = axios.create({
    baseURL: process.env.GRAVY_API_BASE_URL || 'https://api.gravymobile.com',
    timeout: 10000,
    headers: {
        'Authorization': `Bearer ${process.env.GRAVY_API_KEY}`,
        'Content-Type': 'application/json'
    }
});

/**
 * Verify if a user has completed onboarding on Gravy
 *
 * @param {string} accountNumber - The user's Gravy virtual account number
 * @returns {Object} { verified: boolean, accountData: Object|null, error: string|null }
 */
async function verifyOnboarding(accountNumber) {
    try {
        // -------------------------------------------------------
        // TODO: Replace this endpoint with Gravy's actual API
        // This is a placeholder showing the expected contract
        // -------------------------------------------------------
        const response = await gravyClient.get(
            `/api/v1/accounts/${accountNumber}/verify-onboarding`
        );

        const { data } = response;

        if (data && data.is_onboarded === true) {
            return {
                verified: true,
                accountData: {
                    accountNumber: data.account_number,
                    fullName: data.full_name,
                    email: data.email,
                    phoneNumber: data.phone_number,
                    onboardedAt: data.onboarded_at
                },
                error: null
            };
        }

        return {
            verified: false,
            accountData: null,
            error: 'User has not completed onboarding on Gravy'
        };

    } catch (error) {
        // Handle specific API errors
        if (error.response) {
            const status = error.response.status;

            if (status === 404) {
                return {
                    verified: false,
                    accountData: null,
                    error: 'Account number not found on Gravy'
                };
            }

            if (status === 401 || status === 403) {
                console.error('[GravyAPI] Authentication error:', error.response.data);
                return {
                    verified: false,
                    accountData: null,
                    error: 'API authentication error. Contact support.'
                };
            }
        }

        console.error('[GravyAPI] Verification error:', error.message);
        return {
            verified: false,
            accountData: null,
            error: 'Unable to verify at this time. Please try again later.'
        };
    }
}

/**
 * Batch verify multiple accounts (for admin use)
 *
 * @param {string[]} accountNumbers - Array of account numbers
 * @returns {Object[]} Array of verification results
 */
async function batchVerify(accountNumbers) {
    const results = await Promise.allSettled(
        accountNumbers.map(acc => verifyOnboarding(acc))
    );

    return results.map((result, index) => ({
        accountNumber: accountNumbers[index],
        ...(result.status === 'fulfilled' ? result.value : {
            verified: false,
            accountData: null,
            error: 'Verification request failed'
        })
    }));
}

module.exports = { verifyOnboarding, batchVerify };
