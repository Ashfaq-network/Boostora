export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You are Boostora, a professional Website Auditor and Business Growth Consultant AI.

CRITICAL RULES — MUST FOLLOW:
1. Return ONLY raw JSON. No text before or after. No markdown. No backticks. No explanation.
2. Every field in the schema below is REQUIRED. Never omit any field.
3. The summary field MUST be named exactly "summary" — not "executiveSummary", not "executive_summary", not anything else.
4. All scores must be plain numbers (not strings, not objects).

REQUIRED JSON SCHEMA (copy field names exactly):
{
  "overallScore": 0,
  "seoScore": 0,
  "performanceScore": 0,
  "uxScore": 0,
  "mobileScore": 0,
  "summary": "3-4 sentences describing the website's current condition in plain business language.",
  "criticalIssues": [{"issue": "title", "why": "business impact"}],
  "improvements": [{"issue": "title", "why": "business impact"}],
  "workingWell": [{"point": "title", "detail": "explanation"}],
  "fixes": [{"problem": "title", "why": "why it hurts", "steps": ["step 1", "step 2", "step 3"]}],
  "growthStrategies": [{"title": "strategy name", "description": "how to execute"}],
  "verdict": {
    "effective": "Yes",
    "effectiveReason": "one sentence",
    "biggestLoss": "one sentence",
    "biggestOpportunity": "one sentence"
  }
}`;

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    const { url, businessType, goal } = await req.json();

    if (!url || !url.startsWith('http')) {
      return new Response(JSON.stringify({ error: 'Invalid URL' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const PSI_KEY  = process.env.PSI_KEY;
    const GROQ_KEY = process.env.GROQ_KEY;

    if (!GROQ_KEY) {
      return new Response(JSON.stringify({ error: 'Server not configured — GROQ_KEY missing' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // ── 1. Run PageSpeed (mobile only) + page crawl IN PARALLEL ──
    let psiData = null;
    let crawlData = null;

    const psiTimeout  = AbortSignal.timeout(6000);
    const crawlTimeout = AbortSignal.timeout(4000);

    await Promise.allSettled([
      // PageSpeed mobile only (saves ~3-4s vs fetching desktop too)
      PSI_KEY ? fetch(
        `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&category=seo&category=accessibility&category=best-practices&key=${PSI_KEY}`,
        { signal: psiTimeout }
      ).then(async r => {
        if (!r.ok) return;
        const mob    = await r.json();
        const cats   = mob?.lighthouseResult?.categories;
        const audits = mob?.lighthouseResult?.audits;
        if (!cats) return;
        const sc = v => Math.round((v || 0) * 100);
        const ms = v => v ? (v / 1000).toFixed(1) + 's' : 'N/A';
        const dv = v => v?.displayValue || 'N/A';
        psiData = {
          performance:   sc(cats?.performance?.score),
          seo:           sc(cats?.seo?.score),
          accessibility: sc(cats?.accessibility?.score),
          bestPractices: sc(cats?.['best-practices']?.score),
          mobilePerf:    sc(cats?.performance?.score),
          fcp:           ms(audits?.['first-contentful-paint']?.numericValue),
          lcp:           ms(audits?.['largest-contentful-paint']?.numericValue),
          tbt:           dv(audits?.['total-blocking-time']),
          cls:           dv(audits?.['cumulative-layout-shift']),
          speedIndex:    dv(audits?.['speed-index']),
          https:         url.startsWith('https://'),
        };
      }).catch(e => console.warn('PSI failed:', e.message)) : Promise.resolve(),

      // Page crawl in parallel
      fetch(url, {
        headers: { 'User-Agent': 'Boostora-Audit-Bot/1.0' },
        signal: crawlTimeout,
      }).then(async r => {
        if (!r.ok) return;
        const html = await r.text();
        crawlData = extractPageData(html, url);
      }).catch(e => console.warn('Crawl failed:', e.message)),
    ]);

    // ── 2. Build enriched prompt ──
    let prompt = `Analyze this website: ${url}
Business Type: ${businessType || 'Not specified'}
Primary Goal: ${goal || 'Not specified'}
`;

    if (psiData) {
      prompt += `
REAL GOOGLE PAGESPEED DATA (use these exact scores):
- Performance (mobile): ${psiData.performance}/100
- SEO: ${psiData.seo}/100
- Accessibility: ${psiData.accessibility}/100
- Best Practices: ${psiData.bestPractices}/100
- Desktop Performance: ${psiData.desktopPerf}/100
- First Contentful Paint: ${psiData.fcp}
- Largest Contentful Paint: ${psiData.lcp}
- Total Blocking Time: ${psiData.tbt}
- Cumulative Layout Shift: ${psiData.cls}
- Speed Index: ${psiData.speedIndex}
- HTTPS: ${psiData.https ? 'Yes' : 'No'}

Use performanceScore = ${psiData.performance}, seoScore = ${psiData.seo}, mobileScore = ${psiData.mobilePerf}.
Overall = weighted average: (perf×0.35 + seo×0.25 + accessibility×0.20 + mobile×0.20) = ${
  Math.round(psiData.performance*0.35 + psiData.seo*0.25 + psiData.accessibility*0.20 + psiData.mobilePerf*0.20)
}.
Estimate uxScore from the real data and site type.
`;
    }

    if (crawlData) {
      prompt += `
REAL CRAWLED PAGE DATA:
- Title: ${crawlData.title || 'Missing'}
- Meta description: ${crawlData.metaDesc || 'Missing'}
- H1 tags: ${crawlData.h1s.length} found${crawlData.h1s.length ? ' — "' + crawlData.h1s[0] + '"' : ''}
- H2 tags: ${crawlData.h2Count} found
- Images total: ${crawlData.imgCount}, missing alt: ${crawlData.imgNoAlt}
- Internal links: ${crawlData.internalLinks}, External links: ${crawlData.externalLinks}
- Has canonical tag: ${crawlData.hasCanonical ? 'Yes' : 'No'}
- Has robots meta: ${crawlData.hasRobots ? 'Yes' : 'No'}
- Has Open Graph tags: ${crawlData.hasOG ? 'Yes' : 'No'}
- Has schema markup: ${crawlData.hasSchema ? 'Yes' : 'No'}
- Has viewport meta: ${crawlData.hasViewport ? 'Yes' : 'No'}
- Page word count: ~${crawlData.wordCount}
- Has contact info: ${crawlData.hasContact ? 'Yes' : 'No'}
- Has social links: ${crawlData.hasSocial ? 'Yes' : 'No'}
- CTAs detected: ${crawlData.ctaCount}

Base your critical issues and recommendations on this REAL crawled data.
`;
    }

    if (!psiData && !crawlData) {
      prompt += `\nCould not fetch real data. Provide a realistic AI-estimated report based on the URL and business type.`;
    }

    // ── 4. Call Groq AI ──
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1200,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: prompt },
        ],
      }),
    });

    if (!groqRes.ok) {
      const err = await groqRes.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Groq error ${groqRes.status}`);
    }

    const groqData = await groqRes.json();
    let raw = groqData.choices?.[0]?.message?.content || '';
    raw = raw.replace(/```json|```/g, '').trim();
    const report = JSON.parse(raw);

    // ── Normalize summary field — handle any field name AI returns ──
    if (!report.summary) {
      report.summary = report.executiveSummary
        || report.executive_summary
        || report.description
        || report.overview
        || report.analysis
        || report.Synopsis
        || report.synopsis
        || Object.values(report).find(v => typeof v === 'string' && v.length > 80)
        || 'No summary available.';
    }

    console.log('AI report keys:', Object.keys(report));
    console.log('Summary value:', report.summary?.substring?.(0, 100));

    // ── 5. Attach real data to report ──
    if (psiData) {
      report.realData = true;
      report.performanceScore = psiData.performance;
      report.seoScore         = psiData.seo;
      report.mobileScore      = psiData.mobilePerf;
      report.overallScore     = Math.round(
        psiData.performance  * 0.35 +
        psiData.seo          * 0.25 +
        psiData.accessibility * 0.20 +
        psiData.mobilePerf   * 0.20
      );
      report.coreWebVitals = {
        fcp:         psiData.fcp,
        lcp:         psiData.lcp,
        tbt:         psiData.tbt,
        cls:         psiData.cls,
        speedIndex:  psiData.speedIndex,
        https:       psiData.https,
        desktopPerf: psiData.desktopPerf,
        accessibility: psiData.accessibility,
        bestPractices: psiData.bestPractices,
      };
    }
    if (crawlData) {
      report.crawlData = crawlData;
    }

    return new Response(JSON.stringify({ report }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });

  } catch (err) {
    console.error('Audit error:', err);
    return new Response(JSON.stringify({ error: err.message || 'Audit failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

function extractPageData(html, baseUrl) {
  const get  = (re, i = 1) => { const m = html.match(re); return m ? m[i].trim() : null; };
  const count = re => (html.match(re) || []).length;
  const bool  = re => re.test(html);

  const title    = get(/<title[^>]*>([^<]+)<\/title>/i);
  const metaDesc = get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
                || get(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);

  const h1matches = [...html.matchAll(/<h1[^>]*>([^<]+)<\/h1>/gi)];
  const h1s       = h1matches.map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean).slice(0, 3);

  const domain = new URL(baseUrl).hostname;
  const internalLinks = count(new RegExp(`href=["'][^"']*${domain}[^"']*["']`, 'gi'))
                      + count(/href=["']\/[^"']*/gi);
  const externalLinks = count(/href=["']https?:\/\/(?!.*domain)[^"']+["']/gi);

  const imgCount  = count(/<img[^>]+>/gi);
  const imgNoAlt  = count(/<img(?![^>]*alt=["'][^"']+["'])[^>]*>/gi);

  const text      = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const wordCount = text.split(' ').filter(w => w.length > 2).length;

  return {
    title,
    metaDesc,
    h1s,
    h2Count:      count(/<h2[^>]*>/gi),
    imgCount,
    imgNoAlt,
    internalLinks,
    externalLinks,
    wordCount,
    hasCanonical: bool(/<link[^>]+rel=["']canonical["']/i),
    hasRobots:    bool(/<meta[^>]+name=["']robots["']/i),
    hasOG:        bool(/<meta[^>]+property=["']og:/i),
    hasSchema:    bool(/application\/ld\+json/i),
    hasViewport:  bool(/<meta[^>]+name=["']viewport["']/i),
    hasContact:   bool(/contact|email|phone|tel:|mailto:/i),
    hasSocial:    bool(/facebook\.com|twitter\.com|instagram\.com|linkedin\.com|tiktok\.com/i),
    ctaCount:     count(/buy now|get started|sign up|contact us|book|subscribe|try free|learn more/gi),
  };
}
