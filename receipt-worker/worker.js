/**
 * Railway PDF Queue Worker
 *
 * Persistent worker that processes PDF generation jobs from Redis queue.
 * Uses a single persistent browser instance for better performance.
 *
 * Environment Variables Required:
 * - UPSTASH_REDIS_REST_URL
 * - UPSTASH_REDIS_REST_TOKEN
 * - HUBSPOT_ACCESS_TOKEN
 */

const { Redis } = require('@upstash/redis');
const puppeteer = require('puppeteer');
const axios = require('axios');
const FormData = require('form-data');
const crypto = require('crypto');

const QUEUE_KEY = 'pdf-jobs';
const JOB_PREFIX = 'job:';
const MAX_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 2000; // Poll queue every 2 seconds
const DELAY_BETWEEN_JOBS_MS = 1000; // 1 second delay between jobs

let browser = null;
let isShuttingDown = false;

// Initialize Redis connection
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/**
 * Generate secure token for receipt access
 * Token = HMAC(receiptId, SECRET_KEY)
 */
function generateReceiptToken(receiptId) {
  const secretKey = process.env.RECEIPT_SECRET_KEY;
  if (!secretKey) {
    throw new Error('RECEIPT_SECRET_KEY environment variable not set');
  }

  return crypto
    .createHmac('sha256', secretKey)
    .update(receiptId.toString())
    .digest('hex')
    .substring(0, 32); // Use first 32 characters for shorter URLs
}

/**
 * Generate PDF for a single receipt using persistent browser
 */
async function generateReceiptPdf(job, hubspotToken) {
  const { receiptId, domain, pagePath, folderPath, folderId, protocol } = job;

  // Generate secure token for receipt access
  const token = generateReceiptToken(receiptId);
  const receiptPageUrl = `${protocol}://${domain}${pagePath}?receiptId=${receiptId}&token=${token}`;
  console.log(`[${new Date().toISOString()}] Generating PDF for: ${receiptPageUrl} (with token)`);

  const startTime = Date.now();

  try {
    // Create new page in existing browser (much faster than launching new browser)
    const page = await browser.newPage();

    const navigationStart = Date.now();
    await page.goto(receiptPageUrl, {
      waitUntil: 'networkidle0',
      timeout: 30000
    });
    const navigationTime = Date.now() - navigationStart;

    // Generate PDF
    const pdfStart = Date.now();
    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
    });
    const pdfTime = Date.now() - pdfStart;

    await page.close(); // Clean up page

    console.log(`[${new Date().toISOString()}] PDF generated: ${pdfBuffer.length} bytes (nav: ${navigationTime}ms, pdf: ${pdfTime}ms)`);

    // Upload to HubSpot
    const uploadStart = Date.now();
    const fileName = `receipt-${receiptId}-${Date.now()}.pdf`;
    const { Readable } = require('stream');
    const form = new FormData();

    const bufferStream = new Readable();
    bufferStream.push(pdfBuffer);
    bufferStream.push(null);

    form.append('file', bufferStream, {
      filename: fileName,
      contentType: 'application/pdf',
      knownLength: pdfBuffer.length
    });

    form.append('options', JSON.stringify({ access: 'PRIVATE', overwrite: false }));

    if (folderId) {
      form.append('folderId', folderId);
    } else if (folderPath) {
      form.append('folderPath', folderPath);
    } else {
      form.append('folderPath', '/donation-receipts');
    }

    form.append('fileName', fileName);

    const uploadResponse = await axios.post(
      'https://api.hubapi.com/files/v3/files',
      form,
      {
        headers: {
          ...form.getHeaders(),
          'Authorization': `Bearer ${hubspotToken}`
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 30000
      }
    );

    const fileData = uploadResponse.data;
    const uploadTime = Date.now() - uploadStart;

    console.log(`[${new Date().toISOString()}] PDF uploaded: ${fileData.id} (${uploadTime}ms)`);

    // Update receipt object
    const RECEIPTS_OBJECT_ID = '2-53259975';
    const updateStart = Date.now();

    try {
      await axios.patch(
        `https://api.hubapi.com/crm/v3/objects/${RECEIPTS_OBJECT_ID}/${receiptId}`,
        {
          properties: {
            pdf_url: fileData.url,
            pdf_file_id: fileData.id,
            receipt_status: 'Generated'
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${hubspotToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );

      const updateTime = Date.now() - updateStart;
      console.log(`[${new Date().toISOString()}] Receipt ${receiptId} updated (${updateTime}ms)`);
    } catch (updateError) {
      console.error(`[${new Date().toISOString()}] Failed to update receipt ${receiptId}:`, updateError.message);
    }

    const totalTime = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] Job completed in ${totalTime}ms`);

    return {
      success: true,
      pdfUrl: fileData.url,
      pdfId: fileData.id,
      size: pdfBuffer.length,
      timings: {
        navigation: navigationTime,
        pdf: pdfTime,
        upload: uploadTime,
        total: totalTime
      }
    };

  } catch (error) {
    console.error(`[${new Date().toISOString()}] PDF generation failed:`, error.message);
    throw error;
  }
}

/**
 * Process a single job from the queue
 */
async function processJob(jobId, hubspotToken) {
  const jobKey = `${JOB_PREFIX}${jobId}`;

  // Get job data
  const jobDataStr = await redis.get(jobKey);
  if (!jobDataStr) {
    console.log(`[${new Date().toISOString()}] Job ${jobId} not found, skipping`);
    return { skipped: true };
  }

  const job = typeof jobDataStr === 'string' ? JSON.parse(jobDataStr) : jobDataStr;

  // Check attempts
  if (job.attempts >= MAX_ATTEMPTS) {
    console.log(`[${new Date().toISOString()}] Job ${jobId} exceeded max attempts, marking failed`);
    job.status = 'failed';
    job.error = 'Max attempts exceeded';
    await redis.set(jobKey, JSON.stringify(job), { ex: 86400 });
    return { failed: true, reason: 'max_attempts' };
  }

  // Update job status
  job.status = 'processing';
  job.attempts += 1;
  job.processingStartedAt = Date.now();
  await redis.set(jobKey, JSON.stringify(job), { ex: 86400 });

  try {
    const result = await generateReceiptPdf(job, hubspotToken);

    // Mark completed
    job.status = 'completed';
    job.completedAt = Date.now();
    job.result = result;
    await redis.set(jobKey, JSON.stringify(job), { ex: 86400 });

    console.log(`[${new Date().toISOString()}] ✓ Job ${jobId} completed successfully`);
    return { success: true, result };

  } catch (error) {
    console.error(`[${new Date().toISOString()}] ✗ Job ${jobId} failed:`, error.message);

    job.status = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
    job.lastError = error.message;
    await redis.set(jobKey, JSON.stringify(job), { ex: 86400 });

    // Re-queue if not max attempts
    if (job.attempts < MAX_ATTEMPTS) {
      await redis.rpush(QUEUE_KEY, jobId);
    }

    return { failed: true, error: error.message, willRetry: job.attempts < MAX_ATTEMPTS };
  }
}

/**
 * Main worker loop - continuously processes queue
 */
async function workerLoop() {
  const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;

  if (!hubspotToken) {
    console.error('HUBSPOT_ACCESS_TOKEN not set');
    process.exit(1);
  }

  console.log(`[${new Date().toISOString()}] Worker started. Polling queue every ${POLL_INTERVAL_MS}ms...`);

  while (!isShuttingDown) {
    try {
      // Check queue length
      const queueLength = await redis.llen(QUEUE_KEY);

      if (queueLength > 0) {
        console.log(`[${new Date().toISOString()}] Queue has ${queueLength} jobs`);

        // Pop job from queue
        const jobId = await redis.rpop(QUEUE_KEY);

        if (jobId) {
          await processJob(jobId, hubspotToken);

          // Small delay between jobs
          await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_JOBS_MS));
        }
      } else {
        // No jobs - wait before next poll
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      }

    } catch (error) {
      console.error(`[${new Date().toISOString()}] Worker loop error:`, error.message);
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  console.log(`[${new Date().toISOString()}] Worker loop stopped`);
}

/**
 * Initialize and start worker
 */
async function start() {
  console.log(`[${new Date().toISOString()}] Starting PDF Queue Worker...`);

  try {
    // Launch browser once (will be reused for all PDFs)
    console.log(`[${new Date().toISOString()}] Launching browser...`);
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // Overcome limited resource problems
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]
    });
    console.log(`[${new Date().toISOString()}] Browser launched successfully`);

    // Start worker loop
    await workerLoop();

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Fatal error:`, error);
    process.exit(1);
  }
}

/**
 * Graceful shutdown
 */
async function shutdown() {
  console.log(`[${new Date().toISOString()}] Shutting down gracefully...`);
  isShuttingDown = true;

  if (browser) {
    await browser.close();
    console.log(`[${new Date().toISOString()}] Browser closed`);
  }

  process.exit(0);
}

// Handle shutdown signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start the worker
start();
