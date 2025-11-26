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
const { PDFDocument } = require('pdf-lib');

const BATCH_QUEUE_KEY = 'batch-pdf-jobs';
const BATCH_JOB_PREFIX = 'batch-job:';
const MAX_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 5000; // Poll queue every 5 seconds (less frequent than single receipts)
const DELAY_BETWEEN_JOBS_MS = 2000; // 2 second delay between batch jobs
const RECEIPTS_PER_CHUNK = 500; // Safe limit for PDF generation per chunk

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
 * Generate a single PDF chunk for a subset of receipts
 */
async function generatePdfChunk(receiptIds, domain, pagePath, protocol, token, chunkNumber, totalChunks) {
  const page = await browser.newPage();

  try {
    const receiptIdsParam = receiptIds.join(',');
    const chunkPageUrl = `${protocol}://${domain}${pagePath}?receiptIds=${receiptIdsParam}&token=${token}`;

    console.log(`[${new Date().toISOString()}] Chunk ${chunkNumber}/${totalChunks}: Loading page with ${receiptIds.length} receipts...`);

    const navigationStart = Date.now();
    await page.goto(chunkPageUrl, {
      waitUntil: 'networkidle0',
      timeout: 120000 // 2 minute timeout
    });
    const navigationTime = Date.now() - navigationStart;

    const pdfStart = Date.now();
    console.log(`[${new Date().toISOString()}] Chunk ${chunkNumber}/${totalChunks}: Generating PDF...`);

    page.setDefaultTimeout(180000); // 3 minutes

    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
      timeout: 180000 // 3 minute timeout
    });
    const pdfTime = Date.now() - pdfStart;

    console.log(`[${new Date().toISOString()}] Chunk ${chunkNumber}/${totalChunks}: PDF generated - ${pdfBuffer.length} bytes (nav: ${navigationTime}ms, pdf: ${pdfTime}ms)`);

    return pdfBuffer;

  } finally {
    await page.close();
  }
}

/**
 * Merge multiple PDF buffers into a single PDF
 */
async function mergePdfs(pdfBuffers) {
  console.log(`[${new Date().toISOString()}] Merging ${pdfBuffers.length} PDF chunks...`);
  const mergeStart = Date.now();

  const mergedPdf = await PDFDocument.create();

  for (let i = 0; i < pdfBuffers.length; i++) {
    const pdfDoc = await PDFDocument.load(pdfBuffers[i]);
    const copiedPages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
    copiedPages.forEach((page) => mergedPdf.addPage(page));
    console.log(`[${new Date().toISOString()}] Merged chunk ${i + 1}/${pdfBuffers.length} (${copiedPages.length} pages)`);
  }

  const mergedPdfBytes = await mergedPdf.save();
  const mergeTime = Date.now() - mergeStart;

  console.log(`[${new Date().toISOString()}] PDF merge complete: ${mergedPdfBytes.length} bytes (${mergeTime}ms)`);

  return Buffer.from(mergedPdfBytes);
}

/**
 * Generate batch PDF for multiple receipts using persistent browser
 * Splits large batches into chunks, generates separate PDFs, and merges them
 */
async function generateBatchReceiptPdf(job, hubspotToken) {
  const { batchReceiptId, domain, pagePath, folderPath, folderId, protocol, token } = job;

  console.log(`[${new Date().toISOString()}] Starting batch PDF generation for batch ${batchReceiptId}`);

  const startTime = Date.now();

  try {
    // 1. Query HubSpot for associated receipts
    const associationStart = Date.now();
    const receiptIds = await getAssociatedReceipts(batchReceiptId, hubspotToken);
    const associationTime = Date.now() - associationStart;

    if (receiptIds.length === 0) {
      throw new Error('No receipts associated with this batch receipt');
    }

    const receiptCount = receiptIds.length;
    console.log(`[${new Date().toISOString()}] Found ${receiptCount} receipts`);

    // 2. Split receipts into chunks
    const chunks = [];
    for (let i = 0; i < receiptIds.length; i += RECEIPTS_PER_CHUNK) {
      chunks.push(receiptIds.slice(i, i + RECEIPTS_PER_CHUNK));
    }

    const totalChunks = chunks.length;
    console.log(`[${new Date().toISOString()}] Splitting into ${totalChunks} chunks of up to ${RECEIPTS_PER_CHUNK} receipts each`);

    // 3. Generate PDF for each chunk
    const pdfBuffers = [];
    let totalNavigationTime = 0;
    let totalPdfTime = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunkStart = Date.now();
      const pdfBuffer = await generatePdfChunk(
        chunks[i],
        domain,
        pagePath,
        protocol,
        token,
        i + 1,
        totalChunks
      );
      pdfBuffers.push(pdfBuffer);
      const chunkTime = Date.now() - chunkStart;
      totalPdfTime += chunkTime;

      // Small delay between chunks to avoid overwhelming the browser
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // 4. Merge PDFs if multiple chunks, otherwise use single PDF
    let finalPdfBuffer;
    let mergeTime = 0;

    if (pdfBuffers.length > 1) {
      finalPdfBuffer = await mergePdfs(pdfBuffers);
      mergeTime = Date.now() - startTime - associationTime - totalPdfTime;
    } else {
      finalPdfBuffer = pdfBuffers[0];
      console.log(`[${new Date().toISOString()}] Single chunk, no merging needed`);
    }

    console.log(`[${new Date().toISOString()}] Final batch PDF: ${finalPdfBuffer.length} bytes (${receiptCount} receipts)`);
    console.log(`[${new Date().toISOString()}] Timings: association: ${associationTime}ms, chunks: ${totalPdfTime}ms, merge: ${mergeTime}ms`);

    // 5. Upload to HubSpot
    const uploadStart = Date.now();
    const fileName = `batch-receipts-${batchReceiptId}-${Date.now()}.pdf`;
    const { Readable } = require('stream');
    const form = new FormData();

    const bufferStream = new Readable();
    bufferStream.push(finalPdfBuffer);
    bufferStream.push(null);

    form.append('file', bufferStream, {
      filename: fileName,
      contentType: 'application/pdf',
      knownLength: finalPdfBuffer.length
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
      size: finalPdfBuffer.length,
      receiptCount: receiptCount,
      chunks: totalChunks,
      timings: {
        association: associationTime,
        chunks: totalPdfTime,
        merge: mergeTime,
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
