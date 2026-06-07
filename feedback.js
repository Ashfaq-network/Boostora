export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const BLOB_URL   = 'https://api.vercel.com/v1/blob';
const BLOB_TOKEN = () => process.env.BLOB_READ_WRITE_TOKEN;
const FILE_KEY   = 'boostora-reviews.json';

async function getReviews() {
  try {
    // List blobs to find our file
    const listRes = await fetch(`${BLOB_URL}?prefix=${FILE_KEY}`, {
      headers: { Authorization: `Bearer ${BLOB_TOKEN()}` }
    });
    if (!listRes.ok) return [];
    const list = await listRes.json();
    const blob = list.blobs?.find(b => b.pathname === FILE_KEY);
    if (!blob) return [];
    // Fetch the blob content
    const res = await fetch(blob.url);
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

async function saveReviews(reviews) {
  const body = JSON.stringify(reviews);
  const res = await fetch(`${BLOB_URL}/${FILE_KEY}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${BLOB_TOKEN()}`,
      'Content-Type': 'application/json',
      'x-vercel-blob-access': 'public',
    },
    body
  });
  return res.ok;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  if (!BLOB_TOKEN()) {
    if (req.method === 'GET') return new Response(JSON.stringify({ reviews: [] }), { headers: CORS });
    return new Response(JSON.stringify({ error: 'Storage not configured. Add Vercel Blob to your project.' }), { status: 503, headers: CORS });
  }

  // ── GET: return all reviews ──
  if (req.method === 'GET') {
    const reviews = await getReviews();
    return new Response(JSON.stringify({ reviews }), { headers: CORS });
  }

  // ── POST: save a new review ──
  if (req.method === 'POST') {
    try {
      const { name, role, text, rating } = await req.json();
      if (!name || !text || !rating || rating < 1 || rating > 5)
        return new Response(JSON.stringify({ error: 'Invalid data' }), { status: 400, headers: CORS });
      if (text.length < 10 || text.length > 500)
        return new Response(JSON.stringify({ error: 'Review must be 10–500 characters' }), { status: 400, headers: CORS });

      const reviews = await getReviews();
      reviews.unshift({
        id:     Date.now().toString(),
        name:   name.slice(0, 40).replace(/[<>]/g, ''),
        role:   (role || '').slice(0, 60).replace(/[<>]/g, ''),
        text:   text.slice(0, 500).replace(/[<>]/g, ''),
        rating: parseInt(rating),
        date:   new Date().toISOString(),
      });
      await saveReviews(reviews.slice(0, 100));
      return new Response(JSON.stringify({ ok: true }), { headers: CORS });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
    }
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });
}
