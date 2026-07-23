/**
 * Build a map from plain-text offsets (as produced by
 * doc.textBetween(0, doc.content.size, '\n')) to ProseMirror positions.
 *
 * The returned array includes the trailing insertion point, so its length is:
 * plainTextLength + 1
 */
export function buildOffsetMap(doc) {
  const blocks = [];
  let currentBlock = null;

  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      currentBlock = {
        end: pos + node.nodeSize - 1,
        segments: [],
      };
      blocks.push(currentBlock);
      return true;
    }

    if (node.isText && currentBlock) {
      const text = node.text || '';
      if (text.length > 0) {
        currentBlock.segments.push({ pos, text });
      }
    }

    return true;
  });

  const positions = [];
  let offset = 0;

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];

    if (i > 0) {
      // The block separator '\n' maps to the end of the previous textblock.
      positions[offset] = blocks[i - 1].end;
      offset += 1;
    }

    for (const segment of block.segments) {
      for (let charIndex = 0; charIndex < segment.text.length; charIndex += 1) {
        positions[offset] = segment.pos + charIndex;
        offset += 1;
      }
    }
  }

  // End-of-text insertion point. For text docs this is inside the last
  // textblock (not at doc.content.size, which can create a new paragraph).
  const endPos = blocks.length > 0 ? blocks[blocks.length - 1].end : doc.content.size;
  positions[offset] = endPos;

  return positions;
}

export function offsetToPos(doc, offset) {
  if (offset < 0) return 0;

  const positions = buildOffsetMap(doc);
  const fallback = positions[positions.length - 1] ?? doc.content.size;

  if (offset >= positions.length) return fallback;
  return positions[offset] ?? fallback;
}
