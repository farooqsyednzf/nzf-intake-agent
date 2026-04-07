/**
 * NZF Case Review — Zakat Officer Internal Mode
 * 
 * Fetches all case data from Zoho CRM in parallel, downloads attachments,
 * then sends everything to Claude for assessment.
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
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing required environment variables (ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ANTHROPIC_API_KEY)' }) };
  }

  try {
    // ── Step 1: Get Zoho access token ──
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
    if (!caseSearch.data || !caseSearch.data.length) {
      return { statusCode: 200, body: JSON.stringify({ error: `No case found with CASE-ID: ${case_id}. Check the ID and try again.` }) };
    }
    const caseRecord = caseSearch.data[0];
    const caseInternalId = caseRecord.id;
    const contactId = caseRecord.Contact_Name?.id;

    // ── Step 3: Fetch contact, notes, distributions, attachments IN PARALLEL ──
    const [contactRes, notesRes, distRes, attachmentsListRes] = await Promise.all([
      contactId
        ? zget(`${crmBaseUrl}/crm/v2/Contacts/${contactId}?fields=First_Name,Last_Name,Full_Name,Date_of_Birth,Age,Sex,Email,Mobile,Phone,Mailing_Street,Mailing_City,Mailing_State,Mailing_Zip,Marital_Status,Total_Number_of_Household,No_Children_0_4_yrs,No_Children_5_11_yrs,No_Children_12_18_yrs,No_Children_18_yrs,Cultural_Identity,RESIDENCY_STATUS,Interpreter_Required,Interpreter_Lanaguage,Accomodation_Status,Weekly_Rent,MEDICAL_CONDITION,Domestic_Violence,Client_ALERT1,Lead_Source`, auth)
        : Promise.resolve({}),
      zget(`${crmBaseUrl}/crm/v2/Potentials/${caseInternalId}/Notes?fields=Note_Title,Note_Content,Created_By,Created_Time&per_page=50&sort_by=Created_Time&sort_order=asc`, auth),
      zget(`${crmBaseUrl}/crm/v2/Potentials/${caseInternalId}/Purchase_Orders?fields=Distribution_ID,Subject,Status,Distribution_Type,Grand_Total,Sub_Total,Zakat_Category_ies,Project_Code,Approved_Date,Paid_Date,Transfer_Type,Note&per_page=20&sort_by=Created_Time&sort_order=asc`, auth),
      zget(`${crmBaseUrl}/crm/v2/Potentials/${caseInternalId}/Attachments?fields=File_Name,Size,Created_Time,Created_By,$file_id&per_page=20`, auth),
    ]);

    const contactRecord = contactRes.data?.[0] || null;
    const notes         = notesRes.data || [];
    const distributions = distRes.data || [];
    const attachmentList = attachmentsListRes.data || [];

    // ── Step 4: Download supported attachments in parallel ──
    const SUPPORTED = { '.pdf':'application/pdf', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png' };
    const MAX_SIZE  = 4 * 1024 * 1024; // 4MB
    const MAX_FILES = 5;

    const eligible = attachmentList
      .filter(att => {
        const ext = (att.File_Name || '').toLowerCase().match(/\.[^.]+$/)?.[0];
        const size = parseInt(att.Size || '0');
        return SUPPORTED[ext] && size <= MAX_SIZE;
      })
      .slice(0, MAX_FILES);

    const skipped = attachmentList
      .filter(att => !eligible.includes(att))
      .map(att => {
        const ext = (att.File_Name || '').toLowerCase().match(/\.[^.]+$/)?.[0];
        const size = parseInt(att.Size || '0');
        if (!SUPPORTED[ext]) return `${att.File_Name} (unsupported type)`;
        if (size > MAX_SIZE) return `${att.File_Name} (${(size/1024/1024).toFixed(1)}MB — too large)`;
        return `${att.File_Name} (limit reached)`;
      });

    // Download all eligible files in parallel
    const downloadResults = await Promise.allSettled(
      eligible.map(async (att) => {
        const ext = att.File_Name.toLowerCase().match(/\.[^.]+$/)?.[0];
        const mediaType = SUPPORTED[ext];
        const fileRes = await fetch(
          `${crmBaseUrl}/crm/v2/Potentials/${caseInternalId}/Attachments/${att.id}`,
          { headers: auth }
        );
        if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`);
        const buf = await fileRes.arrayBuffer();
        return {
          file_name: att.File_Name,
          media_type: mediaType,
          base64: Buffer.from(buf).toString('base64'),
          uploaded_by: att.Created_By?.name || 'Unknown',
          uploaded_at: att.Created_Time,
          size_kb: Math.round(parseInt(att.Size || '0') / 1024),
        };
      })
    );

    const downloaded = downloadResults
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);
    const failedDownloads = downloadResults
      .filter(r => r.status === 'rejected')
      .map((r, i) => `${eligible[i]?.File_Name} (${r.reason?.message})`);

    // ── Step 5: Build Claude message ──
    const dossier = {
      case: caseRecord,
      contact: contactRecord,
      notes,
      distributions,
      attachments_summary: {
        total_in_crm: attachmentList.length,
        analysed: downloaded.map(a => ({ file_name: a.file_name, uploaded_by: a.uploaded_by, size_kb: a.size_kb })),
        skipped: [...skipped, ...failedDownloads],
      }
    };

    const messageContent = [{
      type: 'text',
      text: `Please review this NZF case and produce the assessment JSON.\n\nCASE DOSSIER:\n${JSON.stringify(dossier, null, 2)}\n\n${downloaded.length > 0 ? `ATTACHMENTS INCLUDED (${downloaded.length}): ${downloaded.map(a => a.file_name).join(', ')}` : 'No analysable attachments for this case.'}`
    }];

    for (const att of downloaded) {
      if (att.media_type === 'application/pdf') {
        messageContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: att.base64 }, title: att.file_name });
      } else {
        messageContent.push({ type: 'image', source: { type: 'base64', media_type: att.media_type, data: att.base64 } });
      }
    }

    // ── Step 6: Send to Claude ──
    const hasPDF = downloaded.some(a => a.media_type === 'application/pdf');
    const claudeHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    };
    if (hasPDF) claudeHeaders['anthropic-beta'] = 'pdfs-2024-09-25';

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: claudeHeaders,
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 6000, system: ASSESSMENT_SYSTEM, messages: [{ role: 'user', content: messageContent }] })
    });

    const claudeData = await claudeRes.json();
    if (!claudeData.content?.[0]?.text) {
      return { statusCode: 200, body: JSON.stringify({ error: 'Claude assessment failed', detail: claudeData.error?.message || JSON.stringify(claudeData).substring(0, 200) }) };
    }

    const raw = claudeData.content[0].text;
    let assessment;
    try {
      assessment = JSON.parse(raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```\s*$/,'').trim());
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) assessment = JSON.parse(m[0]);
      else return { statusCode: 200, body: JSON.stringify({ error: 'Could not parse Claude response as JSON', raw: raw.substring(0, 500) }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        assessment,
        raw_case: caseRecord,
        attachments_analysed: downloaded.map(a => ({ file_name: a.file_name, size_kb: a.size_kb })),
        attachments_skipped: [...skipped, ...failedDownloads],
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
  } catch (e) { console.error('Zoho fetch error', e.message); return {}; }
}

const ASSESSMENT_SYSTEM = `You are a case assessment assistant for NZF Australia (National Zakat Foundation). You have been given the full CRM data for an existing case — the case record, the client contact record, all case notes, any distributions already made, and the actual attachment files (bank statements, utility bills, rental agreements, IDs, etc).

Read and analyse every attachment carefully. Treat them as primary evidence. Cross-reference them against the case notes and description. Note any discrepancies.

CRITICAL: Return ONLY a raw valid JSON object. No markdown, no backticks, no explanation. Start with { and end with }.

{"contact":{"first_name":null,"last_name":null,"email":null,"mobile":null,"date_of_birth":null,"marital_status":null,"residency_status":null,"household_size":null,"number_of_children":null,"children_ages":null,"medical_condition":null,"domestic_violence":false,"interpreter_required":false,"interpreter_language":null,"accommodation_status":null,"weekly_rent":null},"case":{"case_name":null,"case_types":[],"description":null,"priority":null,"is_returning_client":false,"amount_requested":null,"urgency_reason":null},"financial":{"income_source":null,"monthly_income":null,"monthly_rent":null,"other_monthly_expenses":null,"monthly_deficit":null,"has_savings":null,"savings_notes":null},"documents":{"id_verified":false,"id_type":null,"id_name_match":null,"bank_statement_analysed":false,"bank_income_summary":null,"bank_expense_summary":null,"bank_average_balance":null,"bank_alerts":[]},"contradictions":[],"advocacy":{"trigger_category":null,"trigger_detail":null,"what_client_tried":null,"human_impact":null,"support_network":null,"deficit_context":null,"asnaf_category":null,"asnaf_reasoning":null},"intake_note":{"background":null,"immediate_need":null,"underlying_issue":null,"financial_summary":null,"vulnerability_factors":[],"documents_mentioned":[],"documents_outstanding":[]},"recommendation":{"priority_level":null,"zakat_category":null,"flags":[],"eligibility_notes":null,"recommendation_text":null,"suggested_amount":null,"next_steps":null},"distributions":[]}

Contact: map from Contacts record.
Case: case_types from ["Financial hardship - food, bills, medical","Housing - rent, bond, arrears","Funeral debt","Education - courses, Quran school fees","Other"]. priority: "Priority 1 - CRITICAL RISK (24-hour turnaround)" / "Priority 2 - HIGH RISK (2-7 day turnaround)" / "Priority 3 - MODERATE RISK (2-week turnaround)" / "Priority 4 - LOW RISK (1-month turnaround)".
Financial: infer from notes, description, and attachment documents.
Documents: populate from analysing the actual attachment files. id_verified true if government photo ID present. bank_statement_analysed true if bank statement present. bank_alerts: gambling, large unexplained withdrawals, income discrepancy.
Advocacy: trigger_category from ["Job loss / reduced income","Medical / disability","Family breakdown","Arrival / migration","Caring responsibilities","Housing crisis","Unexpected emergency"]. asnaf_reasoning: 2-3 sentence eligibility argument in NZF caseworker style for team leader approval.
Intake note: background 3-4 sentences synthesising the full story. documents_mentioned: list attachments analysed. documents_outstanding: list what is missing but would strengthen the case.
Recommendation: recommendation_text is a compelling advocacy paragraph. Never guarantee support. End with "Eligibility to be confirmed by the assigned Zakat Officer." next_steps: specific actions based on what is missing.
flags from ["DV","URGENT","MEDICAL","CHILDREN","RETURNING CLIENT","DUPLICATE RISK","ELDERLY","REFUGEE/HUMANITARIAN","ID VERIFIED","BANK VERIFIED","INCOME DISCREPANCY","GAMBLING ALERT","CONTRADICTION DETECTED","EMERGENCY - PRIORITY 1"].
priority_level: "High" for P1/P2, "Medium" for P3, "Low" for P4.
zakat_category: "Al-Fuqara (The poor)" / "Al-Masakeen (The needy)" / "Al-Gharimeen (Those in debt)" / "Ibn Al-Sabil (Stranded traveller)".
contradictions: compare case notes/description vs documents. Each: {"field":"..","client_stated":"..","document_shows":"..","severity":"High/Medium/Low","caseworker_note":".."}. Empty array if none.
distributions: array from Purchase Orders — [{"distribution_id":"..","subject":"..","amount":null,"status":"..","date":"..","category":".."}].`;
