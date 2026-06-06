export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You are Boostora, a professional Website Auditor and Business Growth Consultant AI.
Your job is to analyze a website and provide a structured, actionable audit report.

IMPORTANT RULES:
- Be professional like a real SaaS audit tool
- Be concise and structured, not verbose
- Focus on business impact
- Avoid long paragraphs; use brief, punchy sentences
- Return ONLY valid JSON — no preamble, no markdown, no backticks

Return ONLY this exact JSON structure — field names must match exactly, no variations:
{
  "overallScore": number 0-100,
  "seoScore": number 0-100,
  "performanceScore": number 0-100,
  "uxScore": number 0-100,
  "mobileScore": number 0-100,
  "summary": "3-4 sentence plain text summary — THIS FIELD MUST BE CALLED summary NOT executiveSummary",
  "criticalIssues": [{"issue": "short title", "why": "business impact explanation"}],
  "improvements": [{"issue": "short title", "why": "business impact explanation"}],
  "workingWell": [{"point": "short title", "detail": "explanation"}],
  "fixes": [{"problem": "short title", "why": "why it hurts", "steps": ["step 1", "step 2", "step 3"]}],
  "growthStrategies": [{"title": "strategy name", "description": "how to execute it"}],
  "verdict": {
    "effective": "Yes" or "No" or "Partially",
    "effectiveReason": "one sentence",
    "biggestLoss": "one sentence describing biggest reason for lost customers",
    "biggestOpportunity": "one sentence describing biggest growth opportunity"
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

    // ── 1. Fetch PageSpeed Insights (mobile + desktop in parallel) ──
    let psiData = null;
    if (PSI_KEY) {
      try {
        const enc = encodeURIComponent(url);
        const [mobRes, deskRes] = await Promise.all([
          fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${enc}&strategy=mobile&key=${PSI_KEY}`),
          fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${enc}&strategy=desktop&key=${PSI_KEY}`)
        ]);
        const mob  = mobRes.ok  ? await mobRes.json()  : null;
        const desk = deskRes.ok ? await deskRes.json() : null;
        const cats   = mob?.lighthouseResult?.categories;
        const audits = mob?.lighthouseResult?.audits;
        const dcats  = desk?.lighthouseResult?.categories;

        if (cats) {
          const r = v => Math.round((v || 0) * 100);
          const ms = v => v ? (v / 1000).toFixed(1) + 's' : 'N/A';
          const dv = v => v?.displayValue || 'N/A';
          psiData = {
            performance:   r(cats?.performance?.score),
            seo:           r(cats?.seo?.score),
            accessibility: r(cats?.accessibility?.score),
            bestPractices: r(cats?.['best-practices']?.score),
            mobilePerf:    r(cats?.performance?.score),
            desktopPerf:   r(dcats?.performance?.score),
            fcp:           ms(audits?.['first-contentful-paint']?.numericValue),
            lcp:           ms(audits?.['largest-contentful-paint']?.numericValue),
            tbt:           dv(audits?.['total-blocking-time']),
            cls:           dv(audits?.['cumulative-layout-shift']),
            speedIndex:    dv(audits?.['speed-index']),
            https:         url.startsWith('https://'),
          };
        }
      } catch (e) {
        console.warn('PSI fetch failed:', e.message);
      }
    }

    // ── 2. Crawl page HTML for real on-page data ──
    let crawlData = null;
    try {
      const pageRes = await fetch(url, {
        headers: { 'User-Agent': 'Boostora-Audit-Bot/1.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (pageRes.ok) {
        const html = await pageRes.text();
        crawlData = extractPageData(html, url);
      }
    } catch (e) {
      console.warn('Page crawl failed:', e.message);
    }

    // ── 3. Build enriched prompt ──
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
        max_tokens: 2000,
        temperature: 0.3,
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
