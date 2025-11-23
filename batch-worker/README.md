# Batch PDF Queue Worker (Railway)

Persistent worker service that processes **batch** PDF generation jobs from Redis queue. Handles batches with 1000s of receipts.

## Overview

This is a **separate worker** from the individual receipt worker to prevent large batch jobs from blocking the queue.

**Architecture:**
- **Individual receipts**: `railway-worker` → processes `pdf-jobs` queue
- **Batch receipts**: `railway-batch-worker` → processes `batch-pdf-jobs` queue

## Features

- 🔄 **Persistent Browser**: Single browser instance reused across all batch PDFs
- 📊 **Scalable**: Handles batches with 1000s of receipts
- ⏱️ **No Timeout**: Unlike Vercel (60s limit), can process large batches taking 10+ minutes
- 🛡️ **Resilient**: Auto-retries failed jobs, graceful shutdown
- 🔍 **Smart Querying**: Automatically paginates HubSpot associations

## Environment Variables

Required variables (set in Railway dashboard):

```
UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token-here
HUBSPOT_ACCESS_TOKEN=your-hubspot-token
```

## How It Works

1. Worker starts and launches Puppeteer browser **once**
2. Continuously polls `batch-pdf-jobs` queue (every 5 seconds)
3. When batch job found:
   - Queries HubSpot for all associated receipts (handles pagination)
   - Generates single PDF with all receipts using **existing browser**
   - Uploads to HubSpot File Manager
   - Updates batch receipt object with PDF details
4. Repeats until queue is empty

## Performance Estimates

| Receipts in Batch | Estimated Time |
|------------------|----------------|
| 100 | ~30-45 seconds |
| 500 | ~2-3 minutes |
| 1000 | ~4-6 minutes |
| 2000 | ~8-12 minutes |

*Actual times depend on HubSpot CMS page load speed and network conditions*

## Deployment to Railway

### Option 1: Railway CLI

```bash
cd railway-batch-worker
railway login
railway init
railway up
```

### Option 2: GitHub Integration

1. Push this folder to GitHub
2. Connect Railway to your repo
3. Create a **new Railway service** (separate from individual receipt worker)
4. Set root directory to `railway-batch-worker`
5. Add environment variables
6. Deploy

## Local Testing

```bash
cd railway-batch-worker
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
- Association query progress (receipts found per page)
- Batch PDF generation timing
- Upload status
- Performance metrics (receipts/second)

Example log:
```
[2025-11-22T10:30:00.000Z] Batch queue has 3 jobs
[2025-11-22T10:30:01.000Z] Starting batch PDF generation for batch 12345
[2025-11-22T10:30:02.000Z] Page 1: Found 100 receipts (total: 100)
[2025-11-22T10:30:03.000Z] Page 2: Found 100 receipts (total: 200)
[2025-11-22T10:30:04.000Z] Association query complete: 250 receipts found across 3 pages
[2025-11-22T10:30:05.000Z] Loading batch page with 250 receipts...
[2025-11-22T10:30:25.000Z] Generating batch PDF...
[2025-11-22T10:30:35.000Z] Batch PDF generated: 1024000 bytes (250 receipts)
[2025-11-22T10:30:37.000Z] Batch PDF uploaded: 200429172593 (2000ms)
[2025-11-22T10:30:38.000Z] Batch receipt 12345 updated (400ms)
[2025-11-22T10:30:38.000Z] Batch job completed in 37000ms (250 receipts)
[2025-11-22T10:30:38.000Z] Performance: 6.76 receipts/second
```

## Why Separate from Individual Receipt Worker?

1. **Prevent Queue Blocking**: A batch with 1000 receipts taking 5 minutes would block 500 individual receipts from processing
2. **Independent Scaling**: Can scale batch worker separately based on batch job volume
3. **Different Polling Intervals**: Batch jobs are polled every 5s (vs 2s for individual receipts)
4. **Longer Timeouts**: Batch jobs need 2+ minute timeouts vs 30s for individual receipts

## Cost

Railway pricing:
- **Hobby Plan**: $5/month (500 hours) - can run both workers
- **Pro Plan**: Usage-based (~$15-30/month for 2 workers 24/7)

Running both workers simultaneously is recommended for production use.
