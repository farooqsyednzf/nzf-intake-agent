/**
 * NZF Case Review — Zakat Officer Internal Mode
 *
 * Two-phase approach to stay within Netlify's time limit:
 * Phase 1: Fetch all CRM data + download attachments (parallel)
 * Phase 2: Analyse each attachment as TEXT via SYS_DOC (fast, no binary blobs)
 * Phase 3: Send text-only dossier to Claude for final assessment
 *
 * This avoids sending large binary PDFs directly to the main assessment call,
 * which was causing timeout errors.
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
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const accountsUrl  = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
  const crmBaseUrl   = process.env.ZOHO_CRM_BASE_URL  || 'https://www.zohoapis.com';

  if (!clientId || !clientSecret || !refreshToken || !anthropicKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing env vars: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ANTHROPIC_API_KEY' }) };
  }

  try {
    // ── Step 1: Zoho access token ──
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

    // ── Step 2: Find case by CASE_ID ──
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

    // ── Step 3: Fetch all related data in parallel ──
    const [contactRes, notesRes, distRes, attachListRes] = await Promise.all([
      contactId
        ? zget(`${crmBaseUrl}/crm/v2/Contacts/${contactId}?fields=First_Name,Last_Name,Full_Name,Date_of_Birth,Age,Sex,Email,Mobile,Phone,Mailing_Street,Mailing_City,Mailing_State,Mailing_Zip,Marital_Status,Total_Number_of_Household,No_Children_0_4_yrs,No_Children_5_11_yrs,No_Children_12_18_yrs,No_Children_18_yrs,Cultural_Identity,RESIDENCY_STATUS,Interpreter_Required,Interpreter_Lanaguage,Accomodation_Status,Weekly_Rent,MEDICAL_CONDITION,Domestic_Violence,Client_ALERT1,Lead_Source`, auth)
        : Promise.resolve({}),
      zget(`${crmBaseUrl}/crm/v2/Potentials/${caseInternalId}/Notes?fields=Note_Title,Note_Content,Created_By,Created_Time&per_page=50&sort_by=Created_Time&sort_order=asc`, auth),
      zget(`${crmBaseUrl}/crm/v2/Potentials/${caseInternalId}/Purchase_Orders?fields=Distribution_ID,Subject,Status,Distribution_Type,Grand_Total,Zakat_Category_ies,Project_Code,Approved_Date,Paid_Date&per_page=20`, auth),
      zget(`${crmBaseUrl}/crm/v2/Potentials/${caseInternalId}/Attachments?fields=File_Name,Size,Created_Time,Created_By,$file_id&per_page=20`, auth),
    ]);

    const contactRecord = contactRes.data?.[0] || null;
    const notes         = notesRes.data || [];
    const distributions = distRes.data || [];
    const attachmentList = attachListRes.data || [];

    // ── Step 4: Download supported attachments in parallel ──
    const SUPPORTED = { '.pdf':'application/pdf', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png' };
    const MAX_SIZE  = 4 * 1024 * 1024;
    const MAX_FILES = 5;

    const eligible = attachmentList
      .filter(att => {
        const ext = (att.File_Name||'').toLowerCase().match(/\.[^.]+$/)?.[0];
        return SUPPORTED[ext] && parseInt(att.Size||0) <= MAX_SIZE;
      })
      .slice(0, MAX_FILES);

    const skipped = attachmentList
      .filter(att => !eligible.includes(att))
      .map(att => {
        const ext = (att.File_Name||'').toLowerCase().match(/\.[^.]+$/)?.[0];
        if (!SUPPORTED[ext]) return `${att.File_Name} (unsupported type)`;
        if (parseInt(att.Size||0) > MAX_SIZE) return `${att.File_Name} (${(parseInt(att.Size)/1024/1024).toFixed(1)}MB — too large)`;
        return `${att.File_Name} (limit reached)`;
      });

    const downloadResults = await Promise.allSettled(
      eligible.map(async (att) => {
        const ext = att.File_Name.toLowerCase().match(/\.[^.]+$/)?.[0];
        const res = await fetch(`${crmBaseUrl}/crm/v2/Potentials/${caseInternalId}/Attachments/${att.id}`, { headers: auth });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        return {
          file_name: att.File_Name,
          media_type: SUPPORTED[ext],
          base64: Buffer.from(buf).toString('base64'),
          uploaded_by: att.Created_By?.name || 'Unknown',
          size_kb: Math.round(parseInt(att.Size||0) / 1024),
        };
      })
    );

    const downloaded = downloadResults.filter(r => r.status === 'fulfilled').map(r => r.value);
    const failedDL   = downloadResults.filter(r => r.status === 'rejected').map((r,i) => `${eligible[i]?.File_Name} (${r.reason?.message})`);

    // ── Step 5: Analyse each attachment as TEXT using SYS_DOC ──
    // This is the key change — we analyse each file separately as a fast text call,
    // then only send text to the main assessment. No large binary blobs in the final call.
    const docAnalyses = await Promise.allSettled(
      downloaded.map(async (att) => {
        const contentBlock = att.media_type === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: att.base64 }, title: att.file_name }
          : { type: 'image', source: { type: 'base64', media_type: att.media_type, data: att.base64 } };

        const headers = {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        };
        if (att.media_type === 'application/pdf') headers['anthropic-beta'] = 'pdfs-2024-09-25';

        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 800,
            system: SYS_DOC,
            messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: `Analyse this document for NZF case ${case_id}.` }] }]
          })
        });
        const d = await r.json();
        return { file_name: att.file_name, analysis: d.content?.[0]?.text || 'Analysis failed' };
      })
    );

    const analysisResults = docAnalyses
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);
    const analysisFailures = docAnalyses
      .filter(r => r.status === 'rejected')
      .map((r,i) => `${downloaded[i]?.file_name}: ${r.reason?.message}`);

    // ── Step 6: Build text-only dossier ──
    const dossier = {
      case: caseRecord,
      contact: contactRecord,
      notes,
      distributions,
      attachments: {
        total_in_crm: attachmentList.length,
        analysed: analysisResults,
        skipped: [...skipped, ...failedDL, ...analysisFailures],
      }
    };

    // ── Step 7: Final assessment — TEXT ONLY, no binary blobs ──
    const assessRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 6000,
        system: ASSESSMENT_SYSTEM,
        messages: [{ role: 'user', content: `Review this NZF case and produce the assessment JSON.\n\nCASE DOSSIER (includes document analysis results):\n${JSON.stringify(dossier, null, 2)}` }]
      })
    });

    const assessData = await assessRes.json();
    if (!assessData.content?.[0]?.text) {
      return { statusCode: 200, body: JSON.stringify({ error: 'Claude assessment failed', detail: assessData.error?.message || 'unknown' }) };
    }

    const raw = assessData.content[0].text;
    let assessment;
    try {
      assessment = JSON.parse(raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```\s*$/,'').trim());
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) assessment = JSON.parse(m[0]);
      else return { statusCode: 200, body: JSON.stringify({ error: 'Could not parse assessment JSON', raw: raw.substring(0, 500) }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        assessment,
        raw_case: caseRecord,
        attachments_analysed: analysisResults.map(a => ({ file_name: a.file_name })),
        attachments_skipped: [...skipped, ...failedDL],
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

const SYS_DOC = `You are a document analysis assistant for NZF Australia. Analyse this document and output using EXACT labels so a downstream system can extract the data.

For IDENTITY DOCUMENTS (passport, driver licence, Medicare):
DOCUMENT TYPE: [type]
ID NAME: [full name as printed]
ID DOB: [date of birth]
ID ADDRESS: [address or "Not shown"]
ID EXPIRY: [expiry or "Not shown"]
ID VERIFIED: [Yes/No/Partial]
ID NOTES: [any discrepancy with case details, or "None"]

For BANK STATEMENTS:
DOCUMENT TYPE: Bank Statement
BANK NAME: [institution]
ACCOUNT TYPE: [type]
STATEMENT PERIOD: [date range]
INCOME SUMMARY: [sources, amounts, frequency]
EXPENSE SUMMARY: [main categories and monthly totals]
AVERAGE BALANCE: [plain English e.g. "Consistently overdrawn, average approx -$1,200"]
ALERTS: [concerns — gambling, unexplained withdrawals, income mismatch — or "None identified"]

For BILLS / UTILITY / RENT DOCUMENTS:
DOCUMENT TYPE: [type e.g. Electricity Bill, Rent Ledger]
AMOUNT OWING: [amount]
DUE DATE: [date]
PERIOD: [billing period]
NOTES: [anything relevant to the case]

For OTHER documents:
DOCUMENT TYPE: [describe]
SUMMARY: [what it shows and relevance to the Zakat application]

Privacy: Never reproduce full account numbers, BSB, or TFNs. Truncate to last 4 digits only.`;

const ASSESSMENT_SYSTEM = `You are a case assessment assistant for NZF Australia (National Zakat Foundation). You have been given the full CRM dossier for an existing case including case record, contact record, case notes, distributions, and labelled document analysis results for all attachments.

Read the document analyses carefully — they contain income summaries, expense summaries, average balances, and alerts from the actual documents. Use these as primary financial evidence.

CRITICAL: Return ONLY a raw valid JSON object. No markdown, no backticks, no explanation.

{"contact":{"first_name":null,"last_name":null,"email":null,"mobile":null,"date_of_birth":null,"marital_status":null,"residency_status":null,"household_size":null,"number_of_children":null,"children_ages":null,"medical_condition":null,"domestic_violence":false,"interpreter_required":false,"interpreter_language":null,"accommodation_status":null,"weekly_rent":null},"case":{"case_name":null,"case_types":[],"description":null,"priority":null,"is_returning_client":false,"amount_requested":null,"urgency_reason":null},"financial":{"income_source":null,"monthly_income":null,"monthly_rent":null,"other_monthly_expenses":null,"monthly_deficit":null,"has_savings":null,"savings_notes":null},"documents":{"id_verified":false,"id_type":null,"id_name_match":null,"bank_statement_analysed":false,"bank_income_summary":null,"bank_expense_summary":null,"bank_average_balance":null,"bank_alerts":[]},"contradictions":[],"advocacy":{"trigger_category":null,"trigger_detail":null,"what_client_tried":null,"human_impact":null,"support_network":null,"deficit_context":null,"asnaf_category":null,"asnaf_reasoning":null},"intake_note":{"background":null,"immediate_need":null,"underlying_issue":null,"financial_summary":null,"vulnerability_factors":[],"documents_mentioned":[],"documents_outstanding":[]},"recommendation":{"priority_level":null,"zakat_category":null,"flags":[],"eligibility_notes":null,"recommendation_text":null,"suggested_amount":null,"next_steps":null},"distributions":[]}

Rules:
- contact: map from Contacts record
- case: case_types from ["Financial hardship - food, bills, medical","Housing - rent, bond, arrears","Funeral debt","Education - courses, Quran school fees","Other"]. priority: "Priority 1 - CRITICAL RISK (24-hour turnaround)" / "Priority 2 - HIGH RISK (2-7 day turnaround)" / "Priority 3 - MODERATE RISK (2-week turnaround)" / "Priority 4 - LOW RISK (1-month turnaround)"
- financial: use document analysis income/expense/balance data as primary evidence. Fall back to notes/description.
- documents: populate from the labelled document analysis text in attachments[].analysed[].analysis
- advocacy.asnaf_reasoning: 2-3 sentence eligibility argument in NZF Zakat Officer style for team leader approval
- advocacy.deficit_context: contextualise the financial gap with household size and circumstances
- intake_note.background: 3-4 sentences synthesising the full story
- intake_note.documents_mentioned: list file names that were analysed
- intake_note.documents_outstanding: what is missing but would strengthen the case
- recommendation.recommendation_text: compelling advocacy paragraph ending with "Eligibility to be confirmed by the assigned Zakat Officer."
- recommendation.next_steps: specific actions for the Zakat Officer
- flags from: ["DV","URGENT","MEDICAL","CHILDREN","RETURNING CLIENT","DUPLICATE RISK","ELDERLY","REFUGEE/HUMANITARIAN","ID VERIFIED","BANK VERIFIED","INCOME DISCREPANCY","GAMBLING ALERT","CONTRADICTION DETECTED","EMERGENCY - PRIORITY 1"]
- priority_level: "High" for P1/P2, "Medium" for P3, "Low" for P4
- zakat_category: "Al-Fuqara (The poor)" / "Al-Masakeen (The needy)" / "Al-Gharimeen (Those in debt)" / "Ibn Al-Sabil (Stranded traveller)"
- contradictions: compare case notes/description vs document analyses. Each: {"field":"..","client_stated":"..","document_shows":"..","severity":"High/Medium/Low","caseworker_note":".."}
- distributions: from Purchase Orders — [{"distribution_id":"..","subject":"..","amount":null,"status":"..","date":"..","category":".."}]`;
