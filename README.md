# Boostora — AI Website Auditor

Deploy to Vercel in 5 minutes.

## Project Structure

```
boostora-vercel/
├── api/
│   └── audit.js          ← Serverless backend (Groq + PageSpeed + page crawl)
├── public/
│   └── index.html        ← Frontend website
├── vercel.json           ← Routing config
├── package.json
└── .env.example          ← Environment variables template
```

## Deploy Steps

### 1. Install Vercel CLI
```bash
npm install -g vercel
```

### 2. Deploy
```bash
cd boostora-vercel
vercel
```
Follow the prompts — choose "No" for existing project, let it auto-detect.

### 3. Add Environment Variables
In your Vercel dashboard → Project → Settings → Environment Variables:

| Key | Value |
|-----|-------|
| `GROQ_KEY` | Your Groq API key (from console.groq.com) |
| `PSI_KEY` | Your Google PageSpeed key (from console.cloud.google.com) |

Or via CLI:
```bash
vercel env add GROQ_KEY
vercel env add PSI_KEY
vercel --prod
```

### 4. Redeploy after adding env vars
```bash
vercel --prod
```

## What the Backend Does

For every audit request, `api/audit.js`:
1. **Calls Google PageSpeed API** (mobile + desktop in parallel) → real scores
2. **Crawls the actual page** → checks title, meta, H1s, images, alt tags, schema, OG tags, CTAs
3. **Sends all real data to Groq AI** → AI writes the report based on real measurements
4. **Returns full report** → frontend renders scores, Core Web Vitals, issues, fixes, growth tips

## Keys Needed

- **Groq API key** → [console.groq.com](https://console.groq.com) (free)
- **Google PageSpeed key** → [console.cloud.google.com](https://console.cloud.google.com) (free, enable PageSpeed Insights API)
