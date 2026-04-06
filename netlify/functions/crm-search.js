/**
 * NZF CRM Duplicate Check
 * Searches Zoho CRM for existing contacts and recent cases matching the applicant.
 *
 * Required Netlify environment variables:
 *   ZOHO_CLIENT_ID       — Zoho OAuth client ID
 *   ZOHO_CLIENT_SECRET   — Zoho OAuth client secret
 *   ZOHO_REFRESH_TOKEN   — Zoho OAuth refresh token (server-based, no expiry)
 *   ZOHO_ACCOUNTS_URL    — (optional) defaults to https://accounts.zoho.com
 *   ZOHO_CRM_BASE_URL    — (optional) defaults to https://www.zohoapis.com
 *
 * To generate a refresh token:
 *   1. Go to api-console.zoho.com → Server-based Applications
 *   2. Scope: ZohoCRM.modules.READ
 *   3. Generate code → exchange for refresh token
 *   4. Add refresh token to Netlify env vars (never expires unless revoked)
 */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const { first_name, last_name, email, mobile } = JSON.parse(event.body || '{}');

  const clientId     = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;
  const accountsUrl  = process.env.ZOHO_ACCOUNTS_URL  || 'https://accounts.zoho.com';
  const crmBaseUrl   = process.env.ZOHO_CRM_BASE_URL  || 'https://www.zohoapis.com';

  // If not configured, return gracefully — frontend shows "manual check" message
  if (!clientId || !clientSecret || !refreshToken) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configured: false, message: 'CRM credentials not set up' })
    };
  }

  try {
    // ── Get fresh access token ──
    const tokenRes = await fetch(`${accountsUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type:    'refresh_token'
      })
    });
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      console.error('Zoho token error:', tokenData);
      return {
        statusCode: 200,
        body: JSON.stringify({ configured: false, error: 'Could not obtain access token' })
      };
    }

    const headers = { 'Authorization': `Zoho-oauthtoken ${accessToken}` };
    const results = { configured: true, contacts: [], potentials: [] };

    // ── 1. Search Contacts by name ──
    const searchName = [first_name, last_name].filter(Boolean).join(' ').trim();
    if (searchName.length >= 2) {
      const contactRes = await fetch(
        `${crmBaseUrl}/crm/v2/Contacts/search?word=${encodeURIComponent(searchName)}&fields=Full_Name,First_Name,Last_Name,Email,Mobile,Created_Time&per_page=5`,
        { headers }
      );
      if (contactRes.ok) {
        const contactData = await contactRes.json();
        results.contacts = contactData.data || [];
      }
    }

    // Also search by email if provided
    if (email && results.contacts.length === 0) {
      const emailRes = await fetch(
        `${crmBaseUrl}/crm/v2/Contacts/search?email=${encodeURIComponent(email)}&fields=Full_Name,First_Name,Last_Name,Email,Mobile,Created_Time&per_page=5`,
        { headers }
      );
      if (emailRes.ok) {
        const emailData = await emailRes.json();
        if (emailData.data) results.contacts = emailData.data;
      }
    }

    // ── 2. Search Potentials (Cases) from last 6 months by contact ──
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const cutoffDate = sixMonthsAgo.toISOString().split('T')[0]; // YYYY-MM-DD

    // Search Potentials by contact name word search + date filter
    if (searchName.length >= 2) {
      const criteria = `(Created_Time:greater_equal:${cutoffDate})`;
      const potRes = await fetch(
        `${crmBaseUrl}/crm/v2/Potentials/search?word=${encodeURIComponent(searchName)}&criteria=${encodeURIComponent(criteria)}&fields=Deal_Name,Stage,Created_Time,CASE_ID,Contact_Name&per_page=10&sort_by=Created_Time&sort_order=desc`,
        { headers }
      );
      if (potRes.ok) {
        const potData = await potRes.json();
        results.potentials = potData.data || [];
      }
    }

    // Deduplicate potentials by ID
    const seen = new Set();
    results.potentials = results.potentials.filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(results)
    };

  } catch (err) {
    console.error('CRM search error:', err);
    return {
      statusCode: 200, // Always 200 — a CRM failure should not block the intake preview
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configured: false, error: err.message })
    };
  }
};
