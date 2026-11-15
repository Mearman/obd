/**
 * Finding and removing what identifies one car or one unit (the VIN and serial numbers) in shared results and other text. The share link kinds build their redaction on these rules. This module is platform-free.
 */

/** The labels of identification values that identify one car or one unit: the VIN and any serial number. */
const IDENTIFYING_LABEL = /\bvin\b|vehicle identification|serial/i;

/** Whether an identification value with this label identifies the car or the unit, so redaction blanks it. */
export function isIdentifyingLabel(label: string): boolean {
  return IDENTIFYING_LABEL.test(label);
}

/** What redaction puts in place of a removed value in text. */
export const REDACTED = "[redacted]";

/** Seventeen letters and digits without I, O or Q, bounded so a longer run is not cut: the shape of a VIN. */
const VIN_SHAPE = /(?<![A-Z0-9])[A-HJ-NPR-Z0-9]{17}(?![A-Z0-9])/g;

/** Seventeen letters and digits with no restriction on which, bounded so a longer run is not cut. */
const VIN_LENGTH_WORD = /(?<![A-Z0-9])[A-Z0-9]{17}(?![A-Z0-9])/gi;

/**
 * `text` with every word that could be a VIN replaced by `replacement`: seventeen letters and digits, with at least one of each, in either case. A real VIN has no I, O or Q, but text that mentions one may have misread it or come from a simulator, so unlike the scan redaction's own rule this takes those letters too. For text that is not a scan (error messages, logs) that could name a car.
 */
export function redactVinShapes(text: string, replacement: string = REDACTED): string {
  return text.replace(VIN_LENGTH_WORD, (word) =>
    /[A-Za-z]/.test(word) && /[0-9]/.test(word) ? replacement : word,
  );
}

/** The printable ASCII of hexadecimal bytes, with every other byte as U+0000 so no word runs across it, or "" when the text is not whole hexadecimal bytes. Character `n` is byte `n`. */
export function asciiOfHex(hex: string): string {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return "";
  let text = "";
  for (let index = 0; index < hex.length; index += 2) {
    const byte = Number.parseInt(hex.slice(index, index + 2), 16);
    text += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "\u0000";
  }
  return text;
}

/** The lower-case hexadecimal bytes of ASCII text. */
export function hexOfAscii(text: string): string {
  return Array.from(text, (character) =>
    character.charCodeAt(0).toString(16).padStart(2, "0"),
  ).join("");
}

/** VIN-shaped words in `text` that have both a letter and a digit, as a real VIN does. */
export function vinsIn(text: string): string[] {
  return Array.from(text.matchAll(VIN_SHAPE), (match) => match[0]).filter(
    (word) => /[A-Z]/.test(word) && /[0-9]/.test(word),
  );
}

/** The texts to remove: each identifying value, and the hexadecimal spelling of each in both cases. */
export function secretSpellings(values: readonly string[]): string[] {
  return values.flatMap((value) => [
    value,
    hexOfAscii(value).toUpperCase(),
    hexOfAscii(value).toLowerCase(),
  ]);
}

/** `text` with every occurrence of each secret replaced by {@link REDACTED}. */
export function scrub(text: string, secrets: readonly string[]): string {
  return secrets.reduce((current, secret) => current.replaceAll(secret, REDACTED), text);
}
