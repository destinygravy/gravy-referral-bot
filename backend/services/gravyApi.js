/**
 * Gravy Account Verification Service
 *
 * Uses Paystack's Resolve Account API to verify that a user
 * has a legitimate Gravy virtual account (powered by Paga).
 *
 * Verification logic:
 * 1. Call Paystack GET /bank/resolve with account_number + bank_code (Paga)
 * 2. Check that the resolved account_name starts with "Gravy/" (Gravy virtual accounts)
 * 3. Return the verified account data
 */

const axios = require('axios');

const paystackClient = axios.create({
    baseURL: 'https://api.paystack.co',
    timeout: 15000,
    headers: {
        'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
    }
});

// Paga bank code on Paystack
// Use PAGA_BANK_CODE env var, or we'll auto-detect it via the banks list
const PAGA_BANK_CODE = process.env.PAGA_BANK_CODE || '100002';

/**
 * Look up Paga's bank code from Paystack's bank list
 * Called once on startup as a fallback if the env var code doesn't work
 */
let resolvedPagaBankCode = null;
async function getPagaBankCode() {
    if (resolvedPagaBankCode) return resolvedPagaBankCode;

    try {
        const response = await paystackClient.get('/bank', {
            params: { country: 'nigeria', perPage: 200 }
        });

        if (response.data && response.data.data) {
            const pagaBank = response.data.data.find(bank =>
                bank.name.toLowerCase().includes('paga')
            );

            if (pagaBank) {
                resolvedPagaBankCode = pagaBank.code;
                console.log(`[Paystack] Found Paga bank code: ${pagaBank.code} (${pagaBank.name})`);
                return pagaBank.code;
            }
        }
    } catch (e) {
        console.error('[Paystack] Failed to fetch bank list:', e.message);
    }

    // Fallback to env var or default
    return PAGA_BANK_CODE;
}

/**
 * Verify if a user has a valid Gravy virtual account
 *
 * @param {string} accountNumber - The user's Gravy virtual account number
 * @returns {Object} { verified: boolean, accountData: Object|null, apiResponse: Object|null, error: string|null }
 */
async function verifyOnboarding(accountNumber) {
    try {
        // Get Paga bank code (auto-detect or from env)
        const bankCode = await getPagaBankCode();

        // Paystack resolve account: GET /bank/resolve?account_number=XXX&bank_code=XXX
        const response = await paystackClient.get('/bank/resolve', {
            params: {
                account_number: accountNumber,
                bank_code: bankCode
            }
        });

        const { data } = response;

        // Paystack returns { status: true, data: { account_number, account_name } }
        if (data && data.status === true && data.data) {
            const accountName = data.data.account_name || '';
            const resolvedNumber = data.data.account_number || accountNumber;

            console.log(`[Paystack] Resolved account ${accountNumber}: "${accountName}"`);

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
                error: `This account is not a Gravy virtual account. Account name: "${accountName}". Please enter your Gravy account number.`
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
        // Handle Paystack API errors
        if (error.response) {
            const status = error.response.status;
            const errorData = error.response.data;

            if (status === 400) {
                console.error('[Paystack] Bad request:', JSON.stringify(errorData));
                return {
                    verified: false,
                    accountData: null,
                    apiResponse: errorData,
                    error: errorData?.message || 'Invalid account number. Please check and try again.'
                };
            }

            if (status === 401 || status === 403) {
                console.error('[Paystack] Authentication error:', JSON.stringify(errorData));
                return {
                    verified: false,
                    accountData: null,
                    apiResponse: errorData,
                    error: 'Verification service temporarily unavailable. Please try again later.'
                };
            }

            if (status === 404 || status === 422) {
                console.error('[Paystack] Not found/unprocessable:', JSON.stringify(errorData));
                return {
                    verified: false,
                    accountData: null,
                    apiResponse: errorData,
                    error: errorData?.message || 'Account not found. Please check your account number.'
                };
            }

            console.error(`[Paystack] API error (${status}):`, JSON.stringify(errorData));
            return {
                verified: false,
                accountData: null,
                apiResponse: errorData,
                error: 'Verification failed. Please try again later.'
            };
        }

        // Network / timeout error
        console.error('[Paystack] Network error:', error.message);
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
