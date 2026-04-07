/**
 * NZF Case Review — Zakat Officer Internal Mode
 *
 * Fetches all data for a given CASE_ID from Zoho CRM:
 *   - Case record (Potentials)
 *   - Contact record (linked client)
 *   - Case notes
 *   - Distributions (Purchase_Orders)
 *   - Attachments (downloaded and sent to Claude as PDF/image blocks)
 *
 * Required env vars: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ANTHROPIC_API_KEY
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
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing required environment variables' }) };
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
      return { statusCode: 200, body: JSON.stringify({ error: `No case found with CASE-ID: ${case_id}` }) };
    }
    const caseRecord = caseSearch.data[0];
    const caseInternalId = caseRecord.id;
    const contactId = caseRecord.Contact_Name?.id;

    // ── Step 3: Fetch linked contact ──
    let contactRecord = null;
    if (contactId) {
      const contactRes = await zget(
        `${crmBaseUrl}/crm/v2/Contacts/${contactId}?fields=First_Name,Last_Name,Full_Name,Date_of_Birth,Age,Sex,Email,Mobile,Phone,Mailing_Street,Mailing_City,Mailing_State,Mailing_Zip,Marital_Status,Total_Number_of_Household,No_Children_0_4_yrs,No_Children_5_11_yrs,No_Children_12_18_yrs,No_Children_18_yrs,Cultural_Identity,RESIDENCY_STATUS,Interpreter_Required,Interpreter_Lanaguage,Accomodation_Status,Weekly_Rent,MEDICAL_CONDITION,Domestic_Violence,Client_ALERT1,Lead_Source`,
        auth
      );
      contactRecord = contactRes.data?.[0] || null;
    }

    // ── Step 4: Fetch case notes ──
    const notesRes = await zget(
      `${crmBaseUrl}/crm/v2/Potentials/${caseInternalId}/Notes?fields=Note_Title,Note_Content,Created_By,Created_Time&per_page=50&sort_by=Created_Time&sort_order=asc`,
      auth
    );
    const notes = notesRes.data || [];

    // ── Step 5: Fetch distributions ──
    const distRes = await zget(
      `${crmBaseUrl}/crm/v2/Potentials/${caseInternalId}/Purchase_Orders?fields=Distribution_ID,Subject,Status,Distribution_Type,Grand_Total,Sub_Total,Zakat_Category_ies,Project_Code,Approved_Date,Paid_Date,Transfer_Type,Note&per_page=20&sort_by=Created_Time&sort_order=asc`,
      auth
    );
    const distributions = distRes.data || [];

    // ── Step 6: Fetch attachment list ──
    const attachmentsListRes = await zget(
      `${crmBaseUrl}/crm/v2/Potentials/${caseInternalId}/Attachments?fields=File_Name,Size,Created_Time,Created_By,$file_id&per_page=20`,
      auth
    );
    const attachmentList = attachmentsListRes.data || [];

    // ── Step 7: Download supported attachments (PDF and images, max 4MB each, max 5 total) ──
    const SUPPORTED_TYPES = {
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
    };
    const MAX_FILE_SIZE = 4 * 1024 * 1024; // 4MB per file
    const MAX_ATTACHMENTS = 5;

    const downloadedAttachments = [];
    const skippedAttachments = [];

    for (const att of attachmentList) {
      if (downloadedAttachments.length >= MAX_ATTACHMENTS) {
        skippedAttachments.push(`${att.File_Name} (limit reached)`);
        continue;
      }
      const sizeBytes = parseInt(att.Size || '0');
      if (sizeBytes > MAX_FILE_SIZE) {
        skippedAttachments.push(`${att.File_Name} (${(sizeBytes/1024/1024).toFixed(1)}MB — too large)`);
        continue;
      }
      const ext = att.File_Name ? att.File_Name.toLowerCase().match(/\.[^.]+$/)?.[0] : null;
      const mediaType = ext ? SUPPORTED_TYPES[ext] : null;
      if (!mediaType) {
        skippedAttachments.push(`${att.File_Name} (unsupported type)`);
        continue;
      }

      try {
        // Download the file binary
        const fileRes = await fetch(
          `${crmBaseUrl}/crm/v2/Potentials/${caseInternalId}/Attachments/${att.id}`,
          { headers: auth }
        );
        if (!fileRes.ok) {
          skippedAttachments.push(`${att.File_Name} (download failed: ${fileRes.status})`);
          continue;
        }
        const fileBuffer = await fileRes.arrayBuffer();
        const base64 = Buffer.from(fileBuffer).toString('base64');
        downloadedAttachments.push({
          file_name: att.File_Name,
          media_type: mediaType,
          base64: base64,
          uploaded_by: att.Created_By?.name || 'Unknown',
          uploaded_at: att.Created_Time,
          size_kb: Math.round(sizeBytes / 1024),
        });
        console.log(`Downloaded: ${att.File_Name} (${Math.round(sizeBytes/1024)}KB)`);
      } catch (dlErr) {
        skippedAttachments.push(`${att.File_Name} (error: ${dlErr.message})`);
      }
    }

    // ── Step 8: Build the Claude message — dossier text + attachment content blocks ──
    const dossier = {
      case: caseRecord,
      contact: contactRecord,
      notes: notes,
      distributions: distributions,
      attachments_summary: {
        total_in_crm: attachmentList.length,
        analysed: downloadedAttachments.map(a => ({ file_name: a.file_name, uploaded_by: a.uploaded_by, uploaded_at: a.uploaded_at, size_kb: a.size_kb })),
        skipped: skippedAttachments,
      }
    };

    // Build message content array: text dossier + each file as a content block
    const messageContent = [
      {
        type: 'text',
        text: `Please review this NZF case and produce the assessment JSON.\n\nCASE DOSSIER:\n${JSON.stringify(dossier, null, 2)}\n\n${downloadedAttachments.length > 0 ? `ATTACHMENTS INCLUDED BELOW (${downloadedAttachments.length} file${downloadedAttachments.length !== 1 ? 's' : ''}): ${downloadedAttachments.map(a => a.file_name).join(', ')}` : 'No attachments available for this case.'}`
      }
    ];

    // Add each attachment as a content block
    for (const att of downloadedAttachments) {
      if (att.media_type === 'application/pdf') {
        messageContent.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: att.base64 },
          title: att.file_name,
        });
      } else {
        messageContent.push({
          type: 'image',
          source: { type: 'base64', media_type: att.media_type, data: att.base64 },
        });
      }
    }

    // ── Step 9: Send to Claude ──
    const hasPDF = downloadedAttachments.some(a => a.media_type === 'application/pdf');
    const claudeHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    };
    if (hasPDF) claudeHeaders['anthropic-beta'] = 'pdfs-2024-09-25';

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: claudeHeaders,
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 6000,
        system: ASSESSMENT_SYSTEM,
        messages: [{ role: 'user', content: messageContent }]
      })
    });

    const claudeData = await claudeRes.json();
    if (!claudeData.content?.[0]?.text) {
      return { statusCode: 200, body: JSON.stringify({ error: 'Claude assessment failed', raw: claudeData }) };
    }

    const raw = claudeData.content[0].text;
    let assessment;
    try {
      const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      assessment = JSON.parse(clean);
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
        attachments_analysed: downloadedAttachments.map(a => ({ file_name: a.file_name, size_kb: a.size_kb })),
        attachments_skipped: skippedAttachments,
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
    if (!res.ok) { console.error('Zoho API', res.status, url.split('?')[0]); return {}; }
    return res.json();
  } catch (e) { console.error('Zoho fetch error', e.message); return {}; }
}

const ASSESSMENT_SYSTEM = `You are a case assessment assistant for NZF Australia (National Zakat Foundation). You have been given the full CRM data for an existing case — the case record, the client contact record, all case notes, any distributions already made, and the actual attachment files uploaded to the case (bank statements, utility bills, rental agreements, IDs, etc).

Your role is to produce a complete structured JSON assessment of this case. Read and analyse every attachment carefully — treat them as primary evidence. Cross-reference them against what the case notes and description say. Note any discrepancies.

CRITICAL: Return ONLY a raw valid JSON object. No markdown, no backticks, no explanation. Start with { and end with }.

Output this exact structure:
{"contact":{"first_name":null,"last_name":null,"email":null,"mobile":null,"date_of_birth":null,"marital_status":null,"residency_status":null,"household_size":null,"number_of_children":null,"children_ages":null,"medical_condition":null,"domestic_violence":false,"interpreter_required":false,"interpreter_language":null,"accommodation_status":null,"weekly_rent":null},"case":{"case_name":null,"case_types":[],"description":null,"priority":null,"is_returning_client":false,"amount_requested":null,"urgency_reason":null},"financial":{"income_source":null,"monthly_income":null,"monthly_rent":null,"other_monthly_expenses":null,"monthly_deficit":null,"has_savings":null,"savings_notes":null},"documents":{"id_verified":false,"id_type":null,"id_name_match":null,"bank_statement_analysed":false,"bank_income_summary":null,"bank_expense_summary":null,"bank_average_balance":null,"bank_alerts":[]},"contradictions":[],"advocacy":{"trigger_category":null,"trigger_detail":null,"what_client_tried":null,"human_impact":null,"support_network":null,"deficit_context":null,"asnaf_category":null,"asnaf_reasoning":null},"intake_note":{"background":null,"immediate_need":null,"underlying_issue":null,"financial_summary":null,"vulnerability_factors":[],"documents_mentioned":[],"documents_outstanding":[]},"recommendation":{"priority_level":null,"zakat_category":null,"flags":[],"eligibility_notes":null,"recommendation_text":null,"suggested_amount":null,"next_steps":null},"distributions":[]}

FIELD RULES:

Contact: map from the Contacts record.

Case:
- case_types from: ["Financial hardship - food, bills, medical","Housing - rent, bond, arrears","Funeral debt","Education - courses, Quran school fees","Other"]
- priority: "Priority 1 - CRITICAL RISK (24-hour turnaround)" / "Priority 2 - HIGH RISK (2-7 day turnaround)" / "Priority 3 - MODERATE RISK (2-week turnaround)" / "Priority 4 - LOW RISK (1-month turnaround)"
- description: the client's situation in their own words from the Description field

Financial: infer from notes, description, and — most importantly — from the actual attachment documents.

Documents (populate from analysing the attachment files):
- id_verified: true if a government-issued photo ID is present and legible
- id_type: type of ID document found
- id_name_match: compare name on ID to contact record name
- bank_statement_analysed: true if a bank statement is present
- bank_income_summary: income sources, amounts, frequency from bank statement
- bank_expense_summary: main expense categories and amounts from bank statement
- bank_average_balance: plain English description of average balance across the period
- bank_alerts: concerning patterns (gambling, large unexplained withdrawals, income discrepancy, etc.)

Advocacy:
- trigger_category: "Job loss / reduced income" / "Medical / disability" / "Family breakdown" / "Arrival / migration" / "Caring responsibilities" / "Housing crisis" / "Unexpected emergency"
- trigger_detail: 2-3 sentences on what happened and when
- what_client_tried: what they have already attempted before NZF
- human_impact: emotional/social impact beyond finances
- support_network: whether family/community can assist
- deficit_context: contextualise the financial gap with household size and circumstances
- asnaf_category: "Al-Fuqara (The poor)" / "Al-Masakeen (The needy)" / "Al-Gharimeen (Those in debt)" / "Ibn Al-Sabil (Stranded traveller)"
- asnaf_reasoning: 2-3 sentence eligibility argument connecting this client to the Asnaf category, in the style of an NZF Zakat Officer building a case for their team leader

Intake note:
- background: 3-4 sentences synthesising the full story from all sources
- financial_summary: Income $X/month from [source]. Rent/expenses $X/month. Deficit: $X/month.
- vulnerability_factors: array of strings
- documents_mentioned: list of attachments that were analysed
- documents_outstanding: list of documents that would strengthen the case but are missing

Recommendation:
- recommendation_text: compelling advocacy paragraph for the team leader. Include who the client is, what happened, the financial evidence from the documents, what they have tried, and why Zakat support is appropriate. Never guarantee support. End with "Eligibility to be confirmed by the assigned Zakat Officer."
- next_steps: specific actions based on what is missing or outstanding
- flags from: ["DV","URGENT","MEDICAL","CHILDREN","RETURNING CLIENT","DUPLICATE RISK","ELDERLY","REFUGEE/HUMANITARIAN","ID VERIFIED","BANK VERIFIED","INCOME DISCREPANCY","GAMBLING ALERT","CONTRADICTION DETECTED","EMERGENCY - PRIORITY 1"]
- priority_level: "High" for P1/P2, "Medium" for P3, "Low" for P4

Contradictions: compare what the case notes/description say against what the documents show. Each item: {"field":"..","client_stated":"..","document_shows":"..","severity":"High/Medium/Low","caseworker_note":".."}

Distributions: array from the Purchase Orders data — [{"distribution_id":"..","subject":"..","amount":null,"status":"..","date":"..","category":".."}]

zakat_category: "Al-Fuqara (The poor)" / "Al-Masakeen (The needy)" / "Al-Gharimeen (Those in debt)" / "Ibn Al-Sabil (Stranded traveller)"`;
