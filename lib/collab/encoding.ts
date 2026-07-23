export function encodeUpdate(update: Uint8Array): string {
  if (typeof window === 'undefined') {
    return Buffer.from(update).toString('base64');
  }

  let binary = '';
  for (let i = 0; i < update.length; i += 1) {
    binary += String.fromCharCode(update[i]);
  }
  return btoa(binary);
}

export function decodeUpdate(base64: string): Uint8Array {
  if (typeof window === 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
