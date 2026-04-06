/**
 * NZF CRM Duplicate / Prior Application Check
 *
 * Required Netlify env vars:
 *   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
 *
 * Optional (defaults to Australian datacenter):
 *   ZOHO_ACCOUNTS_URL  — defaults to https://accounts.zoho.com.au
 *   ZOHO_CRM_BASE_URL  — defaults to https://www.zohoapis.com.au
 */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const { first_name, last_name, email, mobile } = JSON.parse(event.body || '{}');
  const clientId     = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;
  const accountsUrl  = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
  const crmBaseUrl   = process.env.ZOHO_CRM_BASE_URL  || 'https://www.zohoapis.com';

  if (!clientId || !clientSecret || !refreshToken) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configured: false, message: 'Zoho credentials not configured in Netlify env vars' })
    };
  }

  try {
    // Step 1: Get access token
    const tokenRes = await fetch(`${accountsUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      console.error('Zoho token refresh failed:', JSON.stringify(tokenData));
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configured: false, error: `Zoho token error: ${tokenData.error || tokenData.message || JSON.stringify(tokenData)}. Check your ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REFRESH_TOKEN in Netlify env vars. See Netlify function logs for the full response.` })
      };
    }

    const auth = { 'Authorization': `Zoho-oauthtoken ${tokenData.access_token}` };
    const contactFields = 'Full_Name,First_Name,Last_Name,Email,Mobile,Created_Time';
    const caseFields    = 'Deal_Name,Stage,Created_Time,CASE_ID,Contact_Name';
    const contactsFound = new Map();

    // Multi-strategy contact search
    const fullName = [first_name, last_name].filter(Boolean).join(' ').trim();

    if (fullName.length >= 2) {
      const r = await zget(`${crmBaseUrl}/crm/v2/Contacts/search?word=${enc(fullName)}&fields=${contactFields}&per_page=5`, auth);
      if (r.data) r.data.forEach(c => contactsFound.set(c.id, c));
    }
    if (first_name && first_name.length >= 2 && contactsFound.size < 3) {
      const r = await zget(`${crmBaseUrl}/crm/v2/Contacts/search?word=${enc(first_name)}&fields=${contactFields}&per_page=5`, auth);
      if (r.data) r.data.forEach(c => contactsFound.set(c.id, c));
    }
    if (email) {
      const r = await zget(`${crmBaseUrl}/crm/v2/Contacts/search?email=${enc(email)}&fields=${contactFields}&per_page=3`, auth);
      if (r.data) r.data.forEach(c => contactsFound.set(c.id, c));
    }
    const cleanMobile = mobile ? mobile.replace(/[\s\-().]/g, '') : null;
    if (cleanMobile && cleanMobile.length >= 8) {
      const r = await zget(`${crmBaseUrl}/crm/v2/Contacts/search?phone=${enc(cleanMobile)}&fields=${contactFields}&per_page=3`, auth);
      if (r.data) r.data.forEach(c => contactsFound.set(c.id, c));
    }

    const contacts = Array.from(contactsFound.values()).slice(0, 5);

    // Potentials search — word only (no criteria), filter by date here
    // NOTE: Zoho does NOT allow combining word + criteria in one request
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const casesFound = new Map();

    for (const searchTerm of [fullName, first_name].filter(t => t && t.length >= 2)) {
      const r = await zget(`${crmBaseUrl}/crm/v2/Potentials/search?word=${enc(searchTerm)}&fields=${caseFields}&per_page=10&sort_by=Created_Time&sort_order=desc`, auth);
      if (r.data) r.data.forEach(p => {
        if (new Date(p.Created_Time) >= sixMonthsAgo) casesFound.set(p.id, p);
      });
    }

    const potentials = Array.from(casesFound.values())
      .sort((a, b) => new Date(b.Created_Time) - new Date(a.Created_Time))
      .slice(0, 10);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configured: true, contacts, potentials })
    };

  } catch (err) {
    console.error('CRM search error:', err);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configured: false, error: err.message })
    };
  }
};

async function zget(url, headers) {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.error('Zoho API', res.status, url.split('?')[0]);
      return {};
    }
    return res.json();
  } catch (e) {
    console.error('Zoho fetch error', e.message);
    return {};
  }
}
function enc(s) { return encodeURIComponent(s); }
