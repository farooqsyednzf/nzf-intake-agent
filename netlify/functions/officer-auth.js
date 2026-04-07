/**
 * NZF Officer Auth — Access Code Verification
 *
 * Verifies a shared access code against OFFICER_ACCESS_CODE env var.
 * Returns a signed 8-hour session token if valid.
 *
 * Simple and reliable for an internal tool. The access code is never
 * stored in code — only in Netlify environment variables.
 *
 * Required env var: OFFICER_ACCESS_CODE, ZOHO_CLIENT_SECRET (for signing)
 */
const crypto = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const { access_code } = JSON.parse(event.body || '{}');
  if (!access_code) {
    return { statusCode: 400, body: JSON.stringify({ error: 'access_code is required' }) };
  }

  const expectedCode   = process.env.OFFICER_ACCESS_CODE;
  const signingSecret  = process.env.ZOHO_CLIENT_SECRET;

  if (!expectedCode || !signingSecret) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server not configured. Please contact the NZF system administrator.' }) };
  }

  // Constant-time comparison to prevent timing attacks
  const inputBuf    = Buffer.from(access_code.trim().toLowerCase());
  const expectedBuf = Buffer.from(expectedCode.trim().toLowerCase());
  const valid = inputBuf.length === expectedBuf.length &&
                crypto.timingSafeEqual(inputBuf, expectedBuf);

  if (!valid) {
    return { statusCode: 200, body: JSON.stringify({ error: 'Incorrect access code. Please check with your NZF administrator.' }) };
  }

  // Issue a signed 8-hour session token
  const expiry  = Date.now() + (8 * 60 * 60 * 1000);
  const payload = `nzf-officer|${expiry}`;
  const sig     = crypto.createHmac('sha256', signingSecret).update(payload).digest('hex');
  const token   = Buffer.from(`${payload}|${sig}`).toString('base64');

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: true,
      session_token: token,
      expires_in_hours: 8,
    })
  };
};
