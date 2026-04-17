/**
 * Gravy Account Verification Service
 *
 * Uses Flutterwave's Resolve Account API to verify that a user
 * has a legitimate Gravy virtual account (powered by Paga).
 *
 * Verification logic:
 * 1. Call Flutterwave POST /v3/accounts/resolve with the account number + Paga bank code
 * 2. Check that the resolved account_name starts with "Gravy/" (Gravy virtual accounts)
 * 3. Return the verified account data
 */

const axios = require('axios');

const flutterwaveClient = axios.create({
    baseURL: 'https://api.flutterwave.com',
    timeout: 15000,
    headers: {
        'Authorization': `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
        'Content-Type': 'application/json'
    }
});

// Paga bank code on Flutterwave
const PAGA_BANK_CODE = process.env.PAGA_BANK_CODE || '100002';

/**
 * Verify if a user has a valid Gravy virtual account
 *
 * @param {string} accountNumber - The user's Gravy virtual account number
 * @returns {Object} { verified: boolean, accountData: Object|null, apiResponse: Object|null, error: string|null }
 */
async function verifyOnboarding(accountNumber) {
    try {
        const response = await flutterwaveClient.post('/v3/accounts/resolve', {
            account_number: accountNumber,
            account_bank: PAGA_BANK_CODE
        });

        const { data } = response;

        // Flutterwave returns { status: "success", data: { account_number, account_name } }
        if (data && data.status === 'success' && data.data) {
            const accountName = data.data.account_name || '';
            const resolvedNumber = data.data.account_number || accountNumber;

            // Check that account name starts with "Gravy/" — confirms it's a Gravy virtual account
            if (accountName.toLowerCase().startsWith('gravy/')) {
                return {
                    verified: true,
                    accountData: {
                        accountNumber: resolvedNumber,
                        accountName: accountName,
                        fullName: accountName.replace(/^gravy\//i, '').trim()
                    },
                    apiResponse: data,
                    error: null
                };
            }

            // Account exists but is NOT a Gravy account
            return {
                verified: false,
                accountData: null,
                apiResponse: data,
                error: 'This account is not a Gravy virtual account. Please enter your Gravy account number.'
            };
        }

        // Unexpected response format
        return {
            verified: false,
            accountData: null,
            apiResponse: data,
            error: 'Could not verify account. Please check the account number and try again.'
        };

    } catch (error) {
        // Handle Flutterwave API errors
        if (error.response) {
            const status = error.response.status;
            const errorData = error.response.data;

            if (status === 400) {
                console.error('[Flutterwave] Bad request:', errorData);
                return {
                    verified: false,
                    accountData: null,
                    apiResponse: errorData,
                    error: 'Invalid account number. Please check and try again.'
                };
            }

            if (status === 401 || status === 403) {
                console.error('[Flutterwave] Authentication error:', errorData);
                return {
                    verified: false,
                    accountData: null,
                    apiResponse: errorData,
                    error: 'Verification service temporarily unavailable. Please try again later.'
                };
            }

            if (status === 404) {
                return {
                    verified: false,
                    accountData: null,
                    apiResponse: errorData,
                    error: 'Account not found. Please check your account number.'
                };
            }

            console.error(`[Flutterwave] API error (${status}):`, errorData);
            return {
                verified: false,
                accountData: null,
                apiResponse: errorData,
                error: 'Verification failed. Please try again later.'
            };
        }

        // Network / timeout error
        console.error('[Flutterwave] Network error:', error.message);
        return {
            verified: false,
            accountData: null,
            apiResponse: null,
            error: 'Unable to reach verification service. Please check your connection and try again.'
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
            apiResponse: null,
            error: 'Verification request failed'
        })
    }));
}

module.exports = { verifyOnboarding, batchVerify };
