/** Number formatting that matches the text the Python tool printed, so output stays comparable. */

/**
 * Rounds to three decimals the way Python's `round(value, 3)` does: correctly rounded on the
 * exact binary value, with an exact tie going to the even digit.
 */
export function roundToThousandths(value: number): number {
  // A double's exact decimal expansion is finite, so a tie shows as a 5 after the third decimal
  // and nothing but zeros beyond it.
  const tie = /^(-?)(\d+)\.(\d{2})(\d)50*$/.exec(value.toFixed(60));
  if (tie === null) return Number(value.toFixed(3));
  const [, sign = "", whole = "", hundredths = "", thousandths = ""] = tie;
  const kept = Number(`${whole}${hundredths}${thousandths}`);
  const magnitude = kept % 2 === 0 ? kept : kept + 1;
  return Number(`${sign}${String(magnitude / 1000)}`);
}

/**
 * Formats a finite number as Python's `format(value, f".{digits}g")` does: `digits` significant
 * digits, trailing zeros removed, and an exponent when it is below -4 or at least `digits`.
 */
export function formatSignificant(value: number, digits: number): string {
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const [mantissa = "", exponentText = "0"] = value.toExponential(digits - 1).split("e");
  const exponent = Number(exponentText);
  const trimmed = (text: string): string =>
    text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
  if (exponent < -4 || exponent >= digits) {
    const sign = exponent < 0 ? "-" : "+";
    return `${trimmed(mantissa)}e${sign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  return trimmed(value.toFixed(digits - 1 - exponent));
}

/**
 * Formats text as Python's `repr` does for a `str`: single quotes unless the text holds a single quote and no double quote, a backslash before the quote character used, backslashes, line breaks and tabs, and `\xNN` for other control characters.
 */
export function pythonRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let body = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (character === quote || character === "\\") body += `\\${character}`;
    else if (character === "\n") body += "\\n";
    else if (character === "\r") body += "\\r";
    else if (character === "\t") body += "\\t";
    else if (code < 0x20 || code === 0x7f) body += `\\x${code.toString(16).padStart(2, "0")}`;
    else body += character;
  }
  return `${quote}${body}${quote}`;
}
