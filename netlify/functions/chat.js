/**
 * NZF Intake Agent — Anthropic API Proxy
 * 
 * This function runs server-side on Netlify. It adds the Anthropic API key
 * from the environment variable so the key is never exposed to the browser.
 * 
 * Set ANTHROPIC_API_KEY in Netlify: Site settings → Environment variables
 */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY environment variable is not set. Add it in Netlify → Site settings → Environment variables.' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  // Detect if any message contains a PDF document block — requires the beta header
  const hasPDF = (body.messages || []).some(m =>
    Array.isArray(m.content) && m.content.some(b => b.type === 'document' && b.source?.media_type === 'application/pdf')
  );

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  if (hasPDF) {
    headers['anthropic-beta'] = 'pdfs-2024-09-25';
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic API error:', response.status, JSON.stringify(data));
    }

    return {
      statusCode: response.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Failed to reach Anthropic API: ' + err.message })
    };
  }
};
