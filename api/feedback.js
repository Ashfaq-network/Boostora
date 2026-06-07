export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const KV_URL       = process.env.KV_REST_API_URL;
  const KV_TOKEN     = process.env.KV_REST_API_TOKEN;

  // If KV not configured, return friendly message
  if (!KV_URL || !KV_TOKEN) {
    if (req.method === 'GET') {
      return new Response(JSON.stringify({ reviews: [] }), { headers: CORS });
    }
    return new Response(JSON.stringify({ error: 'Storage not configured. Add Vercel KV to your project.' }), { status: 503, headers: CORS });
  }

  // ── GET: fetch all reviews ──
  if (req.method === 'GET') {
    try {
      const res = await fetch(`${KV_URL}/get/boostora_reviews`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` }
      });
      const data = await res.json();
      const reviews = data.result ? JSON.parse(data.result) : [];
      return new Response(JSON.stringify({ reviews }), { headers: CORS });
    } catch {
      return new Response(JSON.stringify({ reviews: [] }), { headers: CORS });
    }
  }

  // ── POST: save a new review ──
  if (req.method === 'POST') {
    try {
      const { name, role, text, rating } = await req.json();

      // Validate
      if (!name || !text || !rating || rating < 1 || rating > 5) {
        return new Response(JSON.stringify({ error: 'Invalid review data' }), { status: 400, headers: CORS });
      }
      if (text.length < 10 || text.length > 500) {
        return new Response(JSON.stringify({ error: 'Review must be 10–500 characters' }), { status: 400, headers: CORS });
      }

      // Get existing reviews
      const getRes = await fetch(`${KV_URL}/get/boostora_reviews`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` }
      });
      const getData = await getRes.json();
      const reviews = getData.result ? JSON.parse(getData.result) : [];

      // Add new review at top
      const newReview = {
        id:     Date.now().toString(),
        name:   name.slice(0, 40).replace(/[<>]/g, ''),
        role:   (role || '').slice(0, 60).replace(/[<>]/g, ''),
        text:   text.slice(0, 500).replace(/[<>]/g, ''),
        rating: parseInt(rating),
        date:   new Date().toISOString(),
      };
      reviews.unshift(newReview);

      // Keep max 100 reviews
      const trimmed = reviews.slice(0, 100);

      // Save back to KV
      await fetch(`${KV_URL}/set/boostora_reviews`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(JSON.stringify(trimmed))
      });

      return new Response(JSON.stringify({ ok: true }), { headers: CORS });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
    }
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });
}
