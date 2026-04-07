/**
 * NZF Case Review — Data Fetcher Only
 *
 * This function ONLY handles Zoho CRM: fetches case, contact, notes,
 * distributions and downloads attachments. Returns raw data to the browser.
 * 
 * The browser then handles Claude API calls via the existing chat.js proxy —
 * this avoids the 504 gateway inactivity timeout that occurs when a single
 * serverless function makes multiple slow API calls.
 *
 * Required env vars: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
 */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const { case_id } = JSON.parse(event.body || '{}');
  if (!case_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'case_id is required' }) };
  }

  const clientId     = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;
  const accountsUrl  = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
  const crmBaseUrl   = process.env.ZOHO_CRM_BASE_URL  || 'https://www.zohoapis.com';

  if (!clientId || !clientSecret || !refreshToken) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing env vars: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN' }) };
  }

  try {
    // Step 1: Zoho access token
    const tokenRes = await fetch(`${accountsUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return { statusCode: 200, body: JSON.stringify({ error: `Zoho token error: ${tokenData.error || JSON.stringify(tokenData)}` }) };
    }
    const auth = { 'Authorization': `Zoho-oauthtoken ${tokenData.access_token}` };

    // Step 2: Find case
    const caseSearch = await zget(
      `${crmBaseUrl}/crm/v2/Potentials/search?criteria=(CASE_ID:equals:${encodeURIComponent(case_id)})&fields=id,CASE_ID,Deal_Name,Stage,Priority,Pipeline,Intake_Class,Deal_Type,New_or_existing,Case_Type1,Zakat_Category,Family_Unit_Type,Description,Case_Notes_Summary,Contact_Name,Caseworker,Owner,CW_Recommendation,NDM_Reviewed,NM_Reviewed,SDM_Reviewed,Reason_for_Not_Funding,Financial_Instituion,BSB,Account_Number,Created_Time,Modified_Time&per_page=1`,
      auth
    );
    if (!caseSearch.data?.length) {
      return { statusCode: 200, body: JSON.stringify({ error: `No case found with CASE-ID: ${case_id}` }) };
    }
    const caseRecord = caseSearch.data[0];
    const caseInternalId = caseRecord.id;
    const contactId = caseRecord.Contact_Name?.id;

    // Step 3: Fetch contact, notes, distributions, attachment list — all in parallel
    const [contactRes, notesRes, distRes, attachListRes] = await Promise.all([
      contactId
        ? zget(`${crmBaseUrl}/crm/v2/Contacts/${contactId}?fields=First_Name,Last_Name,Full_Name,Date_of_Birth,Age,Sex,Email,Mobile,Phone,Mailing_Street,Mailing_City,Mailing_State,Mailing_Zip,Marital_Status,Total_Number_of_Household,No_Children_0_4_yrs,No_Children_5_11_yrs,No_Children_12_18_yrs,No_Children_18_yrs,Cultural_Identity,RESIDENCY_STATUS,Interpreter_Required,Interpreter_Lanaguage,Accomodation_Status,Weekly_Rent,MEDICAL_CONDITION,Domestic_Violence,Client_ALERT1,Lead_Source`, auth)
        : Promise.resolve({}),
      zget(`${crmBaseUrl}/crm/v2/Potentials/${caseInternalId}/Notes?fields=Note_Title,Note_Content,Created_By,Created_Time&per_page=50&sort_by=Created_Time&sort_order=asc`, auth),
      zget(`${crmBaseUrl}/crm/v2/Potentials/${caseInternalId}/Purchase_Orders?fields=Distribution_ID,Subject,Status,Distribution_Type,Grand_Total,Zakat_Category_ies,Project_Code,Approved_Date,Paid_Date&per_page=20`, auth),
      zget(`${crmBaseUrl}/crm/v2/Potentials/${caseInternalId}/Attachments?fields=File_Name,Size,Created_Time,Created_By,$file_id&per_page=20`, auth),
    ]);

    const contactRecord  = contactRes.data?.[0] || null;
    const notes          = notesRes.data || [];
    const distributions  = distRes.data || [];
    const attachmentList = attachListRes.data || [];

    // Step 4: Download supported attachments in parallel (max 5, max 4MB each)
    // Prioritise: PDFs first (small, fast), then small images. Skip large images.
    // Images > 1MB are slow for Claude vision — skip them and note to view in Zoho CRM.
    const MAX_PDF_SIZE   = 4 * 1024 * 1024; // 4MB for PDFs
    const MAX_IMAGE_SIZE = 1 * 1024 * 1024; // 1MB for images (prevents slow vision calls)
    const MAX_FILES = 5;

    // Prioritise: bank statements / PDFs first, then images
    const sortedList = [...attachmentList].sort((a, b) => {
      const aExt = (a.File_Name||'').toLowerCase().match(/\.[^.]+$/)?.[0];
      const bExt = (b.File_Name||'').toLowerCase().match(/\.[^.]+$/)?.[0];
      const aScore = aExt === '.pdf' ? 0 : 1;
      const bScore = bExt === '.pdf' ? 0 : 1;
      return aScore - bScore || parseInt(a.Size||0) - parseInt(b.Size||0);
    });
    const SUPPORTED = { '.pdf':'application/pdf', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png' };

    const eligible = sortedList.filter(att => {
      const ext = (att.File_Name||'').toLowerCase().match(/\.[^.]+$/)?.[0];
      if (!SUPPORTED[ext]) return false;
      const size = parseInt(att.Size||0);
      return ext === '.pdf' ? size <= MAX_PDF_SIZE : size <= MAX_IMAGE_SIZE;
    }).slice(0, MAX_FILES);

    const skipped = attachmentList
      .filter(att => !eligible.includes(att))
      .map(att => {
        const ext = (att.File_Name||'').toLowerCase().match(/\.[^.]+$/)?.[0];
        if (!SUPPORTED[ext]) return `${att.File_Name} (unsupported type — view in Zoho CRM)`;
        const size = parseInt(att.Size||0);
        const limit = ext === '.pdf' ? MAX_PDF_SIZE : MAX_IMAGE_SIZE;
        if (size > limit) return `${att.File_Name} (${(size/1024/1024).toFixed(1)}MB — view in Zoho CRM directly)`;
        return `${att.File_Name} (limit reached)`;
      });

    const downloaded = downloadResults.filter(r => r.status === 'fulfilled').map(r => r.value);
    const failedDL   = downloadResults.filter(r => r.status === 'rejected').map((r,i) => `${eligible[i]?.File_Name} (download failed)`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        case: caseRecord,
        contact: contactRecord,
        notes,
        distributions,
        attachments: {
          downloaded,
          skipped: [...skipped, ...failedDL],
          total_in_crm: attachmentList.length,
        }
      })
    };

  } catch (err) {
    console.error('Case review error:', err);
    return { statusCode: 200, body: JSON.stringify({ error: err.message }) };
  }
};

async function zget(url, headers) {
  try {
    const res = await fetch(url, { headers });
    if (res.status === 204) return { data: [] };
    if (!res.ok) { console.error('Zoho', res.status, url.split('?')[0]); return {}; }
    return res.json();
  } catch (e) { console.error('Zoho fetch', e.message); return {}; }
}
