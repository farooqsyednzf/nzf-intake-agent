/**
 * NZF Officer Auth — Zoho OAuth Verification
 *
 * Exchanges a Zoho OAuth code for a user token, verifies the user is
 * an active member of the NZF Zoho CRM org, and returns a signed session token.
 *
 * Required env vars: ZOHO_AUTH_CLIENT_ID, ZOHO_AUTH_CLIENT_SECRET, ZOHO_CLIENT_SECRET (for signing)
 */
const crypto = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const { code, redirect_uri } = JSON.parse(event.body || '{}');
  if (!code || !redirect_uri) {
    return { statusCode: 400, body: JSON.stringify({ error: 'code and redirect_uri are required' }) };
  }

  const authClientId     = process.env.ZOHO_AUTH_CLIENT_ID;
  const authClientSecret = process.env.ZOHO_AUTH_CLIENT_SECRET;
  const signingSecret    = process.env.ZOHO_CLIENT_SECRET;
  const refreshToken     = process.env.ZOHO_REFRESH_TOKEN;
  const accountsUrl      = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
  const crmBaseUrl       = process.env.ZOHO_CRM_BASE_URL  || 'https://www.zohoapis.com';

  if (!authClientId || !authClientSecret || !signingSecret || !refreshToken) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server not configured. Contact NZF administrator.' }) };
  }

  try {
    // Step 1: Exchange OAuth code for user access token
    const tokenRes = await fetch(`${accountsUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: authClientId, client_secret: authClientSecret,
        redirect_uri, grant_type: 'authorization_code',
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return { statusCode: 200, body: JSON.stringify({ error: `Login failed: ${tokenData.error || 'could not obtain user token'}` }) };
    }

    // Step 2: Get the current user's details
    const userRes = await fetch(`${crmBaseUrl}/crm/v2/users?type=CurrentUser`, {
      headers: { 'Authorization': `Zoho-oauthtoken ${tokenData.access_token}` }
    });
    const userData = await userRes.json();
    const currentUser = userData.users?.[0];
    if (!currentUser) {
      return { statusCode: 200, body: JSON.stringify({ error: 'Could not retrieve user details from Zoho CRM' }) };
    }

    // Step 3: Verify user is active and confirmed
    if (currentUser.status !== 'active' || !currentUser.confirm) {
      return { statusCode: 200, body: JSON.stringify({ error: `Access denied: ${currentUser.email} is not an active NZF Zoho CRM user` }) };
    }

    // Step 4: Issue signed 8-hour session token
    const expiry  = Date.now() + (8 * 60 * 60 * 1000);
    const payload = `${currentUser.email}|${currentUser.full_name}|${expiry}`;
    const sig     = crypto.createHmac('sha256', signingSecret).update(payload).digest('hex');
    const token   = Buffer.from(`${payload}|${sig}`).toString('base64');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        user: { name: currentUser.full_name, email: currentUser.email, role: currentUser.role?.name },
        session_token: token,
      })
    };

  } catch (err) {
    console.error('Officer auth error:', err);
    return { statusCode: 200, body: JSON.stringify({ error: err.message }) };
  }
};
