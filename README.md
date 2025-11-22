# PDF Queue Worker (Railway)

Persistent worker service that processes PDF generation jobs from Redis queue.

## Features

- ⚡ **Faster Processing**: Persistent browser eliminates 2-second startup per PDF
- 🔄 **Always Running**: No cold starts, processes queue continuously
- 📊 **Better Performance**: Processes ~60-80 PDFs/hour (vs 30/hour with serverless)
- 🛡️ **Resilient**: Auto-retries failed jobs, graceful shutdown

## Performance Comparison

| Setup | PDFs/hour | 500 PDFs |
|-------|-----------|----------|
| Vercel Cron Only | 30 | ~100 min |
| **Railway Worker** | **60-80** | **~40 min** |

## Environment Variables

Required variables (set in Railway dashboard):

```
UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token-here
HUBSPOT_ACCESS_TOKEN=your-hubspot-token
```

## How It Works

1. Worker starts and launches Puppeteer browser **once**
2. Continuously polls Redis queue (every 2 seconds)
3. When job found, uses **existing browser** to generate PDF
4. Uploads to HubSpot and updates receipt object
5. Repeats until queue is empty

## Deployment to Railway

### Option 1: Railway CLI

```bash
cd railway-worker
railway login
railway init
railway up
```

### Option 2: GitHub Integration

1. Push this folder to GitHub
2. Connect Railway to your repo
3. Set root directory to `railway-worker`
4. Add environment variables
5. Deploy

## Local Testing

```bash
cd railway-worker
npm install

# Set environment variables
export UPSTASH_REDIS_REST_URL="https://..."
export UPSTASH_REDIS_REST_TOKEN="..."
export HUBSPOT_ACCESS_TOKEN="..."

# Run worker
npm start
```

## Monitoring

Worker logs show:
- Queue status
- PDF generation timing
- Upload status
- Errors and retries

Example log:
```
[2025-11-21T17:30:00.000Z] Queue has 45 jobs
[2025-11-21T17:30:01.000Z] Generating PDF for: https://...
[2025-11-21T17:30:08.000Z] PDF generated: 54144 bytes (nav: 3200ms, pdf: 800ms)
[2025-11-21T17:30:10.000Z] PDF uploaded: 200429172592 (1800ms)
[2025-11-21T17:30:11.000Z] Receipt 40872927598 updated (400ms)
[2025-11-21T17:30:11.000Z] ✓ Job completed in 8400ms
```

## Cost

Railway pricing:
- **Hobby Plan**: $5/month (500 hours)
- **Pro Plan**: Usage-based (~$10-20/month for 24/7 worker)

## Fallback

Vercel cron still runs as backup - both can run simultaneously without conflicts (they both pull from same queue).
