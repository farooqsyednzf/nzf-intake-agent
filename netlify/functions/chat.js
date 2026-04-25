/**
 * NZF Intake Agent — Anthropic API Proxy
 *
 * Adds:
 *  - PDF beta header when a `document` content block is present
 *  - Retry with exponential backoff for 429 (rate_limit) and 529 (overloaded)
 *  - Distinct error messages for rate limits so the UI can show a clear retry hint
 */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set in Netlify env vars.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  // Detect PDF documents — requires beta header
  const hasPDF = (body.messages || []).some(m =>
    Array.isArray(m.content) && m.content.some(b =>
      b.type === 'document' && b.source?.media_type === 'application/pdf'
    )
  );

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  if (hasPDF) headers['anthropic-beta'] = 'pdfs-2024-09-25';

  // Retry on 429 (rate limit) and 529 (overloaded) — exponential backoff
  const MAX_ATTEMPTS = 3;
  const BASE_DELAY_MS = 2000; // 2s → 4s → 8s

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      // Success
      if (response.ok) {
        const data = await response.json();
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
      }

      // Rate-limited or overloaded — retry with backoff
      if ((response.status === 429 || response.status === 529) && attempt < MAX_ATTEMPTS) {
        // Honour retry-after header if Anthropic sends it
        const retryAfter = parseInt(response.headers.get('retry-after')) * 1000;
        const delay = !isNaN(retryAfter) && retryAfter > 0 ? retryAfter : BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`[chat.js] ${response.status} on attempt ${attempt}, retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      // Non-retryable error or out of retries — surface a clear message
      const errBody = await response.json().catch(() => ({}));
      let userMessage;
      if (response.status === 429) {
        userMessage = 'The system is busy right now. Please wait 30 seconds and try again. If this keeps happening, contact your NZF administrator.';
      } else if (response.status === 529) {
        userMessage = 'Anthropic services are temporarily overloaded. Please wait a moment and retry.';
      } else if (response.status === 401) {
        userMessage = 'API key invalid or revoked. Please contact your NZF administrator.';
      } else if (response.status === 400) {
        userMessage = errBody.error?.message || 'Invalid request — please refresh and try again.';
      } else {
        userMessage = errBody.error?.message || `Service error ${response.status}`;
      }
      console.error(`[chat.js] Final failure ${response.status}:`, errBody);
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { type: errBody.error?.type || 'api_error', message: userMessage, status: response.status } }),
      };

    } catch (err) {
      // Network error — retry
      if (attempt < MAX_ATTEMPTS) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`[chat.js] Network error on attempt ${attempt}, retrying in ${delay}ms:`, err.message);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return { statusCode: 502, body: JSON.stringify({ error: { message: 'Could not reach Anthropic API: ' + err.message, type: 'network_error' } }) };
    }
  }
};
