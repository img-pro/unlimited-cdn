/**
 * HTML viewer with Dieter Rams/Braun design principles
 */

import type { HtmlViewerOptions } from './types';
import { arrayBufferToBase64, formatBytes, formatTime, getCORSHeaders } from './utils';

/**
 * Create HTML viewer with image preview, metadata, and delete button
 */
export function createHtmlViewer(options: HtmlViewerOptions): Response {
  const {
    imageData,
    contentType,
    status,
    imageSize,
    sourceUrl,
    cdnUrl,
    cacheKey,
    cachedAt,
    processingTime,
    logs,
    env
  } = options;

  // Convert image to base64 data URL
  const base64 = arrayBufferToBase64(imageData);
  const dataUrl = `data:${contentType};base64,${base64}`;

  // Generate delete URL - use current origin + cache key
  // This ensures we DELETE via the worker, not the CDN
  const deleteUrl = `/${cacheKey}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ImgPro Image Viewer</title>
  <style>
    /* Dieter Rams / Braun Design Principles */
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
      font-weight: 300;
      font-size: 14px;
      line-height: 1.6;
      color: #1a1a1a;
      background: #f5f5f5;
      padding: 40px 20px;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: #ffffff;
      box-shadow: 0 0 0 1px rgba(0,0,0,0.04);
    }

    header {
      padding: 40px;
      border-bottom: 1px solid #e0e0e0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    h1 {
      font-size: 24px;
      font-weight: 400;
      letter-spacing: -0.5px;
      margin-bottom: 8px;
    }

    .subtitle {
      font-size: 12px;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .delete-btn {
      background: #ff3b30;
      color: white;
      border: none;
      padding: 12px 24px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      cursor: pointer;
      border-radius: 2px;
      transition: background 0.2s;
    }

    .delete-btn:hover {
      background: #d32f2f;
    }

    .delete-btn:disabled {
      background: #ccc;
      cursor: not-allowed;
    }

    .image-section {
      padding: 40px;
      border-bottom: 1px solid #e0e0e0;
    }

    .image-wrapper {
      position: relative;
      background: #fafafa;
      border: 1px solid #e0e0e0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 400px;
    }

    .image-wrapper img {
      max-width: 100%;
      height: auto;
      display: block;
    }

    .info-section {
      padding: 40px;
    }

    .info-columns {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 40px;
    }

    @media (max-width: 900px) {
      .info-columns {
        grid-template-columns: 1fr;
      }
      header {
        flex-direction: column;
        align-items: flex-start;
        gap: 20px;
      }
    }

    .info-grid {
      display: grid;
      gap: 32px;
    }

    .info-block h2 {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1.2px;
      color: #999;
      margin-bottom: 12px;
    }

    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #f0f0f0;
    }

    .info-row:last-child {
      border-bottom: none;
    }

    .info-label {
      font-size: 12px;
      color: #666;
    }

    .info-value {
      font-size: 12px;
      font-weight: 500;
      color: #1a1a1a;
      text-align: right;
    }

    .status-badge {
      display: inline-block;
      padding: 4px 8px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-radius: 2px;
    }

    .status-cached {
      background: #34c759;
      color: #ffffff;
    }

    .status-fetched {
      background: #1a1a1a;
      color: #ffffff;
    }

    .logs {
      background: #fafafa;
      border: 1px solid #e0e0e0;
      padding: 20px;
      max-height: 400px;
      overflow-y: auto;
    }

    .log-entry {
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
      font-size: 11px;
      padding: 6px 0;
      display: grid;
      grid-template-columns: 60px 1fr 2fr;
      gap: 12px;
      border-bottom: 1px solid #f0f0f0;
    }

    .log-entry:last-child {
      border-bottom: none;
    }

    .log-time {
      color: #999;
      text-align: right;
    }

    .log-action {
      color: #1a1a1a;
      font-weight: 500;
    }

    .log-details {
      color: #666;
    }

    .url-block {
      background: #fafafa;
      padding: 12px;
      border: 1px solid #e0e0e0;
      margin-top: 8px;
    }

    .url-block a {
      color: #1a1a1a;
      text-decoration: none;
      font-size: 11px;
      word-break: break-all;
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
    }

    .url-block a:hover {
      text-decoration: underline;
    }

    #message {
      padding: 12px 16px;
      margin: 20px 0;
      border-radius: 2px;
      font-size: 12px;
      display: none;
    }

    #message.success {
      background: #d4edda;
      color: #155724;
      border: 1px solid #c3e6cb;
    }

    #message.error {
      background: #f8d7da;
      color: #721c24;
      border: 1px solid #f5c6cb;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>CDN Image Viewer</h1>
        <div class="subtitle">ImgPro CDN Worker · Version 1.2.0</div>
      </div>
      <button class="delete-btn" id="deleteBtn" onclick="deleteImage()">Delete Image</button>
    </header>

    <div id="message"></div>

    <div class="image-section">
      <div class="image-wrapper">
        <img src="${dataUrl}" alt="CDN cached image" id="imagePreview" />
      </div>
    </div>

    <div class="info-section">
      <div class="info-columns">
        <div class="info-grid">
          <div class="info-block">
            <h2>Status</h2>
            <div class="info-row">
              <div class="info-label">Cache Status</div>
              <div class="info-value">
                <span class="status-badge status-${status}">${status}</span>
              </div>
            </div>
            <div class="info-row">
              <div class="info-label">Processing Time</div>
              <div class="info-value">${formatTime(processingTime)}</div>
            </div>
          </div>

          <div class="info-block">
            <h2>File Information</h2>
            <div class="info-row">
              <div class="info-label">Size</div>
              <div class="info-value">${formatBytes(imageSize)}</div>
            </div>
            <div class="info-row">
              <div class="info-label">Content Type</div>
              <div class="info-value">${contentType}</div>
            </div>
          </div>

          <div class="info-block">
            <h2>URLs</h2>
            <div class="info-row">
              <div class="info-label">Cache Key</div>
            </div>
            <div class="url-block">
              <a href="${sourceUrl}" target="_blank">${cacheKey}</a>
            </div>
            <div class="info-row" style="margin-top: 16px;">
              <div class="info-label">CDN URL</div>
            </div>
            <div class="url-block">
              <a href="${cdnUrl}" target="_blank">${cdnUrl}</a>
            </div>
            ${cachedAt ? `
            <div class="info-row" style="margin-top: 16px;">
              <div class="info-label">Cached At</div>
              <div class="info-value">${new Date(cachedAt).toLocaleString()}</div>
            </div>
            ` : ''}
          </div>
        </div>

        <div class="info-grid">
          <div class="info-block">
            <h2>Workflow Log</h2>
            <div class="logs">
              ${logs.map(log => `
                <div class="log-entry">
                  <div class="log-time">${log.time}</div>
                  <div class="log-action">${log.action}</div>
                  <div class="log-details">${log.details || ''}</div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const deleteUrl = '${deleteUrl}';

    async function deleteImage() {
      const btn = document.getElementById('deleteBtn');
      const message = document.getElementById('message');
      const img = document.getElementById('imagePreview');

      if (!confirm('Are you sure you want to delete this image from the cache?')) {
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Deleting...';
      message.style.display = 'none';

      try {
        const response = await fetch(deleteUrl, {
          method: 'DELETE',
        });

        if (response.ok) {
          const result = await response.json();
          message.className = 'success';
          message.textContent = 'Image deleted successfully from cache';
          message.style.display = 'block';

          // Fade out image
          img.style.opacity = '0.3';
          btn.textContent = 'Deleted';
          btn.style.background = '#999';
        } else {
          throw new Error('Failed to delete image');
        }
      } catch (error) {
        message.className = 'error';
        message.textContent = 'Error deleting image: ' + error.message;
        message.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Delete Image';
      }
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      ...getCORSHeaders(),
    },
  });
}
