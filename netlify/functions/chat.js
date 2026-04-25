/**
 * NZF Intake Agent — Anthropic API Proxy
 *
 * Thin server-side proxy. Adds:
 *  - PDF beta header when a `document` content block is present
 *  - Clear, structured error messages so the browser can decide what to do
 *
 * NO retries inside this function — retries happen browser-side (no timeout there).
 * This keeps total Netlify function time well under the 26s gateway limit.
 */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: { message: 'ANTHROPIC_API_KEY not set in Netlify env vars.' } }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: { message: 'Invalid JSON body' } }) }; }

  // PDF documents require the beta header
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

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const data = await response.json();
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
    }

    // Surface a structured error the browser can act on
    const errBody = await response.json().catch(() => ({}));
    const retryAfter = response.headers.get('retry-after');
    let userMessage;

    if (response.status === 429) {
      userMessage = 'The system is busy. Please wait a moment and try again.';
    } else if (response.status === 529) {
      userMessage = 'Anthropic services are temporarily overloaded. Please retry shortly.';
    } else if (response.status === 401) {
      userMessage = 'API key invalid or revoked. Please contact your NZF administrator.';
    } else if (response.status === 400) {
      userMessage = errBody.error?.message || 'Invalid request — please refresh and try again.';
    } else {
      userMessage = errBody.error?.message || `Service error ${response.status}`;
    }

    console.error(`[chat.js] ${response.status}:`, errBody);
    return {
      statusCode: response.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: {
          type: errBody.error?.type || 'api_error',
          message: userMessage,
          status: response.status,
          retry_after: retryAfter ? parseInt(retryAfter) : null,
          retryable: response.status === 429 || response.status === 529,
        }
      }),
    };

  } catch (err) {
    console.error('[chat.js] Network error:', err);
    return {
      statusCode: 502,
      body: JSON.stringify({
        error: { message: 'Could not reach Anthropic API: ' + err.message, type: 'network_error', retryable: true }
      })
    };
  }
};
