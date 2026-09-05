const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/** Keep complete Unicode code points, remove NUL, and stop before maxBytes. */
export function truncateUtf8(value: string, maxBytes: number): string {
  const limit = Math.max(0, Math.floor(maxBytes));
  let used = 0;
  let result = '';
  for (const character of value) {
    if (character === String.fromCharCode(0)) continue;
    const width = utf8ByteLength(character);
    if (used + width > limit) break;
    result += character;
    used += width;
  }
  return result;
}
