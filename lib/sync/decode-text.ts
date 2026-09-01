// Companion to `policy.ts`: policy decides text-vs-binary, this decodes the
// bytes of everything it called text.
//
// `Blob.text()` / `Buffer#toString('utf8')` are replacement decoders — a
// latin-1 `.tex` or `.bib` (still common in cloned repos and arXiv sources)
// loses every accented character to U+FFFD before it reaches `content_text`,
// and the damage is permanent. Fall back to latin-1 instead: it maps every
// byte to a code point, so the text survives intact and modern LaTeX kernels
// read the resulting UTF-8 natively.

const LATIN1_CHUNK = 0x8000;

export function decodeTextBytes(bytes: Uint8Array): { text: string; nonUtf8: boolean } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), nonUtf8: false };
  } catch {
    // Not `TextDecoder('iso-8859-1')`: WHATWG aliases that label to
    // windows-1252, which still drops five undefined bytes to U+FFFD.
    let text = '';
    for (let i = 0; i < bytes.length; i += LATIN1_CHUNK) {
      text += String.fromCharCode(...bytes.subarray(i, i + LATIN1_CHUNK));
    }
    return { text, nonUtf8: true };
  }
}

/** Same decode for the browser ingestion paths, which start from a Blob. */
export async function decodeTextBlob(blob: Blob): Promise<string> {
  return decodeTextBytes(new Uint8Array(await blob.arrayBuffer())).text;
}
