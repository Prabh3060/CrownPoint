// Netlify Function: /api/notify  (mapped via netlify.toml redirect)
// Body: { name, email, sessionId, files: [{ name, key }] }
//
// Called once, after all of a client's files have finished uploading.
// Generates a temporary (7-day) download link for each file and emails
// them to the firm — no login into the storage dashboard required.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Resend } = require('resend');

const s3 = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

const resend = new Resend(process.env.RESEND_API_KEY);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*', // tighten to your domain in production
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  try {
    const { name, email, sessionId, files } = JSON.parse(event.body || '{}');

    if (!sessionId || !Array.isArray(files) || files.length === 0) {
      return json(400, { error: 'sessionId and a non-empty files array are required' });
    }
    if (files.length > 30) {
      return json(400, { error: 'Too many files in one submission' });
    }

    // Generate a 7-day download link for each uploaded file.
    const links = await Promise.all(
      files.map(async (f) => {
        if (!f.key || !f.key.startsWith(`uploads/${sessionId}/`)) {
          throw new Error('File key does not match this session');
        }
        const command = new GetObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: f.key,
        });
        const url = await getSignedUrl(s3, command, { expiresIn: 60 * 60 * 24 * 7 }); // 7 days
        return { name: f.name || f.key, url };
      })
    );

    const listHtml = links
      .map((l) => `<li><a href="${l.url}">${escapeHtml(l.name)}</a></li>`)
      .join('');

    await resend.emails.send({
      from: process.env.NOTIFY_FROM_EMAIL,
      to: process.env.NOTIFY_TO_EMAIL,
      subject: `New client documents uploaded${name ? ` — ${name}` : ''}`,
      html: `
        <p><strong>${name ? escapeHtml(name) : 'A client'}</strong> just uploaded ${links.length} document(s) through the website.</p>
        ${email ? `<p>Client email: ${escapeHtml(email)}</p>` : ''}
        <p>Download links (expire in 7 days):</p>
        <ul>${listHtml}</ul>
        <p style="color:#888;font-size:0.85em;">Session ID: ${escapeHtml(sessionId)}</p>
      `,
    });

    return json(200, { success: true });
  } catch (err) {
    console.error('notify error:', err);
    return json(500, { error: 'Failed to send notification' });
  }
};
