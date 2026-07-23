#!/usr/bin/env node

import { stdin, stdout } from 'node:process';
import { Y, canonicalizeMarkdown, replaceFromMarkdown, serializeDoc } from './markdown_yjs.mjs';
import { readDocumentText, replaceDocumentText } from './document_text.mjs';

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function writeOk(payload) {
  stdout.write(JSON.stringify({ ok: true, ...payload }));
}

function writeError(error) {
  stdout.write(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
}

function docFromMarkdown(markdown) {
  const doc = new Y.Doc();
  replaceFromMarkdown(doc, markdown ?? '');
  return doc;
}

try {
  const request = JSON.parse(await readStdin() || '{}');

  switch (request.operation) {
    case 'normalize': {
      writeOk({ markdown: canonicalizeMarkdown(request.markdown) });
      break;
    }
    case 'normalize_batch': {
      // Normalize many markdown docs in ONE node process. A bulk clone would
      // otherwise spawn a node process per file (~150ms startup each), which
      // dominates the doc-store mirror time. Each item is isolated: a doc that
      // fails to parse keeps its original text rather than failing the batch.
      const items = Array.isArray(request.items) ? request.items : [];
      const results = items.map((item) => {
        try {
          return { key: item.key, markdown: canonicalizeMarkdown(item.markdown) };
        } catch (error) {
          return { key: item.key, markdown: item.markdown ?? '', error: String(error) };
        }
      });
      writeOk({ results });
      break;
    }
    case 'markdown_to_update': {
      const doc = docFromMarkdown(request.markdown);
      try {
        writeOk({ update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') });
      } finally {
        doc.destroy();
      }
      break;
    }
    case 'text_to_update': {
      const doc = new Y.Doc();
      try {
        replaceDocumentText(request.path || 'document.txt', doc, request.text ?? '');
        writeOk({ update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') });
      } finally {
        doc.destroy();
      }
      break;
    }
    case 'update_to_markdown': {
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, new Uint8Array(Buffer.from(request.update || '', 'base64')));
        writeOk({ markdown: serializeDoc(doc) });
      } finally {
        doc.destroy();
      }
      break;
    }
    case 'update_to_text': {
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, new Uint8Array(Buffer.from(request.update || '', 'base64')));
        writeOk({ text: readDocumentText(request.path || 'document.txt', doc) });
      } finally {
        doc.destroy();
      }
      break;
    }
    default:
      throw new Error(`Unknown markdown codec operation: ${request.operation}`);
  }
} catch (error) {
  writeError(error);
}
