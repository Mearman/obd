/**
 * Byte and hexadecimal helpers shared by the protocol layers. Platform-free: no `Buffer` and no
 * `TextEncoder`, which the core type libraries do not declare.
 */

/** Formats `value` as upper-case hexadecimal, zero-padded on the left to at least `width` digits. */
export function hexNumber(value: number, width: number): string {
  return value.toString(16).toUpperCase().padStart(width, "0");
}

/** The bytes as lower-case hexadecimal with no separators. */
export function toHex(data: Uint8Array): string {
  return Array.from(data, (byte) => hexNumber(byte, 2).toLowerCase()).join("");
}

/** The bytes as upper-case hexadecimal with no separators. */
export function toUpperHex(data: Uint8Array): string {
  return toHex(data).toUpperCase();
}

/**
 * Parses pairs of hexadecimal digits, of either case, into bytes.
 *
 * @throws SyntaxError if the text has an odd length or a character that is not a hexadecimal digit.
 */
export function fromHex(text: string): Uint8Array {
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) {
    throw new SyntaxError(`not whole hexadecimal bytes: ${JSON.stringify(text)}`);
  }
  const out = new Uint8Array(text.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(text.slice(2 * index, 2 * index + 2), 16);
  }
  return out;
}

/** The parts joined end to end into a new array. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Whether both arrays hold the same bytes in the same order. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * The byte at `index`. Callers use it where a length check has already proved the index in range.
 *
 * @throws RangeError if `index` is outside the array.
 */
export function byteAt(data: Uint8Array, index: number): number {
  const byte = data[index];
  if (byte === undefined) {
    throw new RangeError(
      `byte ${String(index)} is outside an array of ${String(data.length)} bytes`,
    );
  }
  return byte;
}

/**
 * Encodes ASCII text as bytes.
 *
 * @throws RangeError if the text has a character above 0x7F.
 */
export function asciiEncode(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code > 0x7f) {
      throw new RangeError(`character ${JSON.stringify(text[index])} is not ASCII`);
    }
    out[index] = code;
  }
  return out;
}

/** Decodes bytes as ASCII, replacing every byte above 0x7F with U+FFFD. */
export function asciiDecode(data: Uint8Array): string {
  return Array.from(data, (byte) => (byte > 0x7f ? "�" : String.fromCharCode(byte))).join("");
}

/** The number of bytes `text` takes as UTF-8, counting each UTF-16 surrogate unit as two bytes. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    // A surrogate pair is two UTF-16 units and four UTF-8 bytes, so each unit counts two.
    bytes += code < 0x80 ? 1 : code < 0x800 || (code >= 0xd800 && code < 0xe000) ? 2 : 3;
  }
  return bytes;
}
