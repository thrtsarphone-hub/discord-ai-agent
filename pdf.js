'use strict';

// PDF text extraction with pdfjs-dist (Node-compatible legacy build).

let pdfjs = null;

async function getPdfjs() {
  if (!pdfjs) {
    // Legacy build works in plain Node without a DOM/canvas.
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjs;
}

async function extractPdfText(buffer) {
  const pdfjsLib = await getPdfjs();
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;

  const pages = doc.numPages;
  const maxPages = Math.min(pages, 80);
  let text = '';
  for (let i = 1; i <= maxPages; i += 1) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    text += tc.items.map((it) => it.str).join(' ');
    text += '\n';
  }
  try { await doc.destroy(); } catch (e) { /* ignore */ }
  return { text: text.slice(0, 120000), pages };
}

module.exports = { extractPdfText };
