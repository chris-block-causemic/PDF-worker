# PDF Service Workers (Railway)

Persistent worker services that process PDF generation jobs from Redis queues.

## Architecture

This repository contains two Railway workers that operate independently:

```
┌─────────────────────────────────────────────────────────────┐
│  INDIVIDUAL RECEIPTS                                         │
│  Queue: pdf-jobs                                             │
│  Worker: receipt-worker/                                     │
│  Processing: ~25 PDFs/minute                                 │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  BATCH RECEIPTS                                              │
│  Queue: batch-pdf-jobs                                       │
│  Worker: batch-worker/                                       │
│  Processing: Batches with 1000s of receipts                  │
└─────────────────────────────────────────────────────────────┘
```

## Workers

### 1. Receipt Worker (`receipt-worker/`)
- **Queue**: `pdf-jobs`
- **Purpose**: Process individual receipt PDFs quickly
- **Performance**: ~25 PDFs/minute
- **Polling**: Every 2 seconds
- **See**: [receipt-worker/README.md](receipt-worker/README.md)

### 2. Batch Worker (`batch-worker/`)
- **Queue**: `batch-pdf-jobs`
- **Purpose**: Process batch receipts with 100s-1000s of receipts
- **Performance**: Handles large batches taking 5-10+ minutes
- **Polling**: Every 5 seconds
- **See**: [batch-worker/README.md](batch-worker/README.md)

## Railway Deployment

Both workers run in the **same Railway project** as **separate services**.

### Setup in Railway

1. **Create Railway Project**: `pdf-workers`

2. **Add Service 1 - Receipt Worker**:
   - Service name: `receipt-worker`
   - Root directory: `receipt-worker`
   - Environment variables:
     - `UPSTASH_REDIS_REST_URL`
     - `UPSTASH_REDIS_REST_TOKEN`
     - `HUBSPOT_ACCESS_TOKEN`

3. **Add Service 2 - Batch Worker**:
   - Service name: `batch-worker`
   - Root directory: `batch-worker`
   - Environment variables: (same as above, shared at project level)

### Environment Variables

Set these at the **project level** in Railway (shared by both workers):

```bash
UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token-here
HUBSPOT_ACCESS_TOKEN=your-hubspot-token
```

## Local Development

### Receipt Worker
```bash
cd receipt-worker
npm install

export UPSTASH_REDIS_REST_URL="https://..."
export UPSTASH_REDIS_REST_TOKEN="..."
export HUBSPOT_ACCESS_TOKEN="..."

npm start
```

### Batch Worker
```bash
cd batch-worker
npm install

export UPSTASH_REDIS_REST_URL="https://..."
export UPSTASH_REDIS_REST_TOKEN="..."
export HUBSPOT_ACCESS_TOKEN="..."

npm start
```

## Monitoring

Both workers log to stdout. View logs in Railway dashboard:
- **Receipt Worker**: Shows individual PDF processing (~8-10s per PDF)
- **Batch Worker**: Shows batch processing with receipt counts and performance metrics

## Performance

| Worker | Metric | Value |
|--------|--------|-------|
| Receipt Worker | PDFs per minute | ~25 |
| Receipt Worker | Time per PDF | ~8-10 seconds |
| Batch Worker | 500 receipts | ~2-3 minutes |
| Batch Worker | 1000 receipts | ~4-6 minutes |
| Batch Worker | 2000 receipts | ~8-12 minutes |

## Cost

**Railway Pricing**:
- **Hobby Plan**: $5/month (500 execution hours)
  - Both workers can run on Hobby plan
- **Pro Plan**: Usage-based (~$15-30/month for 2 workers 24/7)

## Why Separate Workers?

1. **No Queue Blocking**: Large batch jobs (5+ min) don't block individual receipts
2. **Independent Scaling**: Scale each worker based on usage
3. **Different Timeouts**: Batch needs 2+ min vs 30s for individual
4. **Optimized Polling**: Different polling intervals for different job types

## Deployment

### Initial Setup
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link to project
railway link
```

### Deploy Both Workers
Railway will automatically deploy both services when you push to the connected git branch.

```bash
git add .
git commit -m "Update workers"
git push
```

Railway will detect the Dockerfiles and build each service independently.

## Related Repositories

- **HubSpot Project**: `../src/` - HubSpot CMS templates and workflow actions
- **Vercel Functions**: `../vercel-version/` - Serverless endpoints for enqueueing jobs
