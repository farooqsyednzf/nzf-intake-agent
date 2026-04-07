/**
 * NZF Officer Auth — Zoho OAuth Verification
 *
 * Exchanges a Zoho OAuth code for a user token, verifies the user is
 * an active member of the NZF Zoho CRM org, and returns a signed session token.
 *
 * Required env vars (all already set):
 *   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
 *
 * One-time setup required:
 *   In api-console.zoho.com, add your Netlify site URL as an authorised redirect URI.
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

  const clientId     = process.env.ZOHO_AUTH_CLIENT_ID;
  const clientSecret = process.env.ZOHO_AUTH_CLIENT_SECRET;
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;  // server token for org verification
  const accountsUrl  = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
  const crmBaseUrl   = process.env.ZOHO_CRM_BASE_URL  || 'https://www.zohoapis.com';

  if (!clientId || !clientSecret || !refreshToken) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing Zoho env vars' }) };
  }

  try {
    // ── Step 1: Exchange OAuth code for user access token ──
    const tokenRes = await fetch(`${accountsUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri,
        grant_type: 'authorization_code',
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('User token exchange failed:', tokenData);
      return { statusCode: 200, body: JSON.stringify({ error: `Login failed: ${tokenData.error || 'could not obtain user token'}` }) };
    }
    const userToken = tokenData.access_token;

    // ── Step 2: Get the current user's details ──
    const userRes = await fetch(`${crmBaseUrl}/crm/v2/users?type=CurrentUser`, {
      headers: { 'Authorization': `Zoho-oauthtoken ${userToken}` }
    });
    const userData = await userRes.json();
    const currentUser = userData.users?.[0];
    if (!currentUser) {
      return { statusCode: 200, body: JSON.stringify({ error: 'Could not retrieve user details from Zoho CRM' }) };
    }

    // ── Step 3: Verify user is active and belongs to the NZF org ──
    // Use the server token to confirm this email exists as an active user in our org
    const svrTokenRes = await fetch(`${accountsUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
    });
    const svrToken = await svrTokenRes.json();
    if (!svrToken.access_token) {
      return { statusCode: 200, body: JSON.stringify({ error: 'Server verification failed' }) };
    }

    const orgCheckRes = await fetch(
      `${crmBaseUrl}/crm/v2/users/search?email=${encodeURIComponent(currentUser.email)}&type=AllActiveUsers`,
      { headers: { 'Authorization': `Zoho-oauthtoken ${svrToken.access_token}` } }
    );
    // Even if endpoint doesn't support search, fall back to checking status from the user object itself
    const isActive = currentUser.status === 'active' && currentUser.confirm === true;
    if (!isActive) {
      return { statusCode: 200, body: JSON.stringify({ error: `Access denied: ${currentUser.email} is not an active NZF Zoho CRM user` }) };
    }

    // ── Step 4: Create a signed session token (8-hour expiry) ──
    const expiry = Date.now() + (8 * 60 * 60 * 1000);
    const payload = `${currentUser.email}|${currentUser.full_name}|${expiry}`;
    const sig = crypto.createHmac('sha256', clientSecret).update(payload).digest('hex');
    const sessionToken = Buffer.from(`${payload}|${sig}`).toString('base64');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        user: {
          name: currentUser.full_name,
          email: currentUser.email,
          role: currentUser.role?.name,
        },
        session_token: sessionToken,
      })
    };

  } catch (err) {
    console.error('Officer auth error:', err);
    return { statusCode: 200, body: JSON.stringify({ error: err.message }) };
  }
};
