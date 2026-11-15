import { AdapterUrlError } from "../core/transport.js";

/**
 * Reads an adapter URL parameter that is a non-negative whole number, in decimal or `0x` hex.
 *
 * @throws AdapterUrlError when it is anything else.
 */
export function parseInteger(name: string, text: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) {
    throw new AdapterUrlError(
      `${name} must be a non-negative integer (decimal or 0x hex): ${text}`,
    );
  }
  return value;
}
