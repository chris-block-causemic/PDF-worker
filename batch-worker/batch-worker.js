/**
 * Railway Batch PDF Queue Worker
 *
 * Persistent worker that processes batch PDF generation jobs from Redis queue.
 * Uses a single persistent browser instance for better performance.
 * Handles batches with 1000s of receipts.
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

const BATCH_QUEUE_KEY = 'batch-pdf-jobs';
const BATCH_JOB_PREFIX = 'batch-job:';
const MAX_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 5000; // Poll queue every 5 seconds (less frequent than single receipts)
const DELAY_BETWEEN_JOBS_MS = 2000; // 2 second delay between batch jobs

let browser = null;
let isShuttingDown = false;

// Initialize Redis connection
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/**
 * Query HubSpot for all receipts associated with a batch receipt
 */
async function getAssociatedReceipts(batchReceiptId, hubspotToken) {
  const allReceiptIds = [];
  let after = undefined;
  let pageCount = 0;

  const BATCH_RECEIPTS_OBJECT_ID = '2-53326638';
  const RECEIPTS_OBJECT_ID = '2-53259975';

  console.log(`[${new Date().toISOString()}] Querying associations for batch receipt ${batchReceiptId}...`);

  do {
    pageCount++;
    const url = `https://api.hubapi.com/crm/v4/objects/${BATCH_RECEIPTS_OBJECT_ID}/${batchReceiptId}/associations/${RECEIPTS_OBJECT_ID}`;

    try {
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${hubspotToken}`,
          'Content-Type': 'application/json'
        },
        params: {
          limit: 100,
          after: after
        },
        timeout: 15000
      });

      const results = response.data.results || [];
      const receiptIds = results.map(r => r.toObjectId);
      allReceiptIds.push(...receiptIds);

      console.log(`[${new Date().toISOString()}] Page ${pageCount}: Found ${receiptIds.length} receipts (total: ${allReceiptIds.length})`);

      after = response.data.paging?.next?.after;

    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error querying associations (page ${pageCount}):`, error.message);
      throw new Error(`Failed to query associated receipts: ${error.message}`);
    }

  } while (after);

  console.log(`[${new Date().toISOString()}] Association query complete: ${allReceiptIds.length} receipts found across ${pageCount} pages`);
  return allReceiptIds;
}

/**
 * Generate batch PDF for multiple receipts using persistent browser
 */
async function generateBatchReceiptPdf(job, hubspotToken) {
  const { batchReceiptId, domain, pagePath, folderPath, folderId, protocol, password } = job;

  console.log(`[${new Date().toISOString()}] Starting batch PDF generation for batch ${batchReceiptId}`);

  const startTime = Date.now();

  try {
    // 1. Query HubSpot for all associated receipts
    const associationStart = Date.now();
    const receiptIds = await getAssociatedReceipts(batchReceiptId, hubspotToken);
    const associationTime = Date.now() - associationStart;

    if (receiptIds.length === 0) {
      throw new Error('No receipts associated with this batch receipt');
    }

    const receiptCount = receiptIds.length;
    console.log(`[${new Date().toISOString()}] Found ${receiptCount} receipts, generating batch PDF...`);

    // 2. Construct batch receipt page URL with all receipt IDs
    const receiptIdsParam = encodeURIComponent(JSON.stringify(receiptIds));
    const batchPageUrl = `${protocol}://${domain}${pagePath}?receiptIds=${receiptIdsParam}`;

    console.log(`[${new Date().toISOString()}] Batch page URL length: ${batchPageUrl.length} characters`);

    // 3. Generate PDF using existing browser
    const page = await browser.newPage();

    const navigationStart = Date.now();
    console.log(`[${new Date().toISOString()}] Loading batch page with ${receiptCount} receipts...`);

    // Navigate to page (don't wait yet if password is needed)
    if (password) {
      // Load page but don't wait for network idle yet
      await page.goto(batchPageUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 120000
      });

      try {
        console.log(`[${new Date().toISOString()}] Password provided, filling password field...`);

        // Wait for password field and fill it
        await page.waitForSelector('input[name="password"]', { timeout: 5000 });
        await page.type('input[name="password"]', password);

        // Find and click submit button
        const submitButton = await page.$('button[type="submit"]');
        if (submitButton) {
          await submitButton.click();
          console.log(`[${new Date().toISOString()}] Password submitted, waiting for batch page to load...`);

          // Wait for navigation after password submission (longer timeout for large batches)
          await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 120000 });
        } else {
          console.warn(`[${new Date().toISOString()}] Submit button not found, trying network idle...`);
          await page.waitForNetworkIdle({ timeout: 10000 });
        }

        console.log(`[${new Date().toISOString()}] Password authentication successful`);
      } catch (passwordError) {
        console.warn(`[${new Date().toISOString()}] Password authentication failed: ${passwordError.message}`);
        // Continue anyway - might work without password
      }
    } else {
      // No password - normal page load
      await page.goto(batchPageUrl, {
        waitUntil: 'networkidle0',
        timeout: 120000 // 2 minute timeout for large batches
      });
    }

    const navigationTime = Date.now() - navigationStart;

    const pdfStart = Date.now();
    console.log(`[${new Date().toISOString()}] Generating batch PDF...`);

    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
    });
    const pdfTime = Date.now() - pdfStart;

    await page.close();

    console.log(`[${new Date().toISOString()}] Batch PDF generated: ${pdfBuffer.length} bytes (${receiptCount} receipts)`);
    console.log(`[${new Date().toISOString()}] Timings: association: ${associationTime}ms, nav: ${navigationTime}ms, pdf: ${pdfTime}ms`);

    // 4. Upload to HubSpot
    const uploadStart = Date.now();
    const fileName = `batch-receipts-${batchReceiptId}-${Date.now()}.pdf`;
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
      form.append('folderPath', '/donation-receipts/batches');
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
        timeout: 60000 // Longer timeout for large files
      }
    );

    const fileData = uploadResponse.data;
    const uploadTime = Date.now() - uploadStart;

    console.log(`[${new Date().toISOString()}] Batch PDF uploaded: ${fileData.id} (${uploadTime}ms)`);

    // 5. Update batch receipt object
    const BATCH_RECEIPTS_OBJECT_ID = '2-53326638';
    const updateStart = Date.now();

    try {
      await axios.patch(
        `https://api.hubapi.com/crm/v3/objects/${BATCH_RECEIPTS_OBJECT_ID}/${batchReceiptId}`,
        {
          properties: {
            pdf_url: fileData.url,
            pdf_file_id: fileData.id,
            receipt_count: receiptCount,
            status: 'Generated'
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
      console.log(`[${new Date().toISOString()}] Batch receipt ${batchReceiptId} updated (${updateTime}ms)`);
    } catch (updateError) {
      console.error(`[${new Date().toISOString()}] Failed to update batch receipt ${batchReceiptId}:`, updateError.message);
    }

    const totalTime = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] Batch job completed in ${totalTime}ms (${receiptCount} receipts)`);
    console.log(`[${new Date().toISOString()}] Performance: ${(receiptCount / (totalTime / 1000)).toFixed(2)} receipts/second`);

    return {
      success: true,
      pdfUrl: fileData.url,
      pdfId: fileData.id,
      size: pdfBuffer.length,
      receiptCount: receiptCount,
      timings: {
        association: associationTime,
        navigation: navigationTime,
        pdf: pdfTime,
        upload: uploadTime,
        total: totalTime,
        receiptsPerSecond: (receiptCount / (totalTime / 1000)).toFixed(2)
      }
    };

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Batch PDF generation failed:`, error.message);
    throw error;
  }
}

/**
 * Process a single batch job from the queue
 */
async function processBatchJob(jobId, hubspotToken) {
  const jobKey = `${BATCH_JOB_PREFIX}${jobId}`;

  // Get job data
  const jobDataStr = await redis.get(jobKey);
  if (!jobDataStr) {
    console.log(`[${new Date().toISOString()}] Batch job ${jobId} not found, skipping`);
    return { skipped: true };
  }

  const job = typeof jobDataStr === 'string' ? JSON.parse(jobDataStr) : jobDataStr;

  // Check attempts
  if (job.attempts >= MAX_ATTEMPTS) {
    console.log(`[${new Date().toISOString()}] Batch job ${jobId} exceeded max attempts, marking failed`);
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
    const result = await generateBatchReceiptPdf(job, hubspotToken);

    // Mark completed
    job.status = 'completed';
    job.completedAt = Date.now();
    job.result = result;
    await redis.set(jobKey, JSON.stringify(job), { ex: 86400 });

    console.log(`[${new Date().toISOString()}] ✓ Batch job ${jobId} completed successfully`);
    return { success: true, result };

  } catch (error) {
    console.error(`[${new Date().toISOString()}] ✗ Batch job ${jobId} failed:`, error.message);

    job.status = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
    job.lastError = error.message;
    await redis.set(jobKey, JSON.stringify(job), { ex: 86400 });

    // Re-queue if not max attempts
    if (job.attempts < MAX_ATTEMPTS) {
      await redis.rpush(BATCH_QUEUE_KEY, jobId);
    }

    return { failed: true, error: error.message, willRetry: job.attempts < MAX_ATTEMPTS };
  }
}

/**
 * Main worker loop - continuously processes batch queue
 */
async function workerLoop() {
  const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;

  if (!hubspotToken) {
    console.error('HUBSPOT_ACCESS_TOKEN not set');
    process.exit(1);
  }

  console.log(`[${new Date().toISOString()}] Batch worker started. Polling queue every ${POLL_INTERVAL_MS}ms...`);

  while (!isShuttingDown) {
    try {
      // Check queue length
      const queueLength = await redis.llen(BATCH_QUEUE_KEY);

      if (queueLength > 0) {
        console.log(`[${new Date().toISOString()}] Batch queue has ${queueLength} jobs`);

        // Pop job from queue
        const jobId = await redis.rpop(BATCH_QUEUE_KEY);

        if (jobId) {
          await processBatchJob(jobId, hubspotToken);

          // Delay between batch jobs (they're heavy)
          await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_JOBS_MS));
        }
      } else {
        // No jobs - wait before next poll
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      }

    } catch (error) {
      console.error(`[${new Date().toISOString()}] Batch worker loop error:`, error.message);
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  console.log(`[${new Date().toISOString()}] Batch worker loop stopped`);
}

/**
 * Initialize and start batch worker
 */
async function start() {
  console.log(`[${new Date().toISOString()}] Starting Batch PDF Queue Worker...`);

  try {
    // Launch browser once (will be reused for all batch PDFs)
    console.log(`[${new Date().toISOString()}] Launching browser...`);
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
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

// Start the batch worker
start();
