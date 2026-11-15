/**
 * JSON text that matches what Python's `json.dump(value, file, indent=2)` writes, so the saved scans and snapshots are the same bytes from either tool.
 *
 * A JavaScript object lists integer-like keys such as `5123` first and in numeric order, which loses the order a unit reported its fault codes in, so an object with a meaningful key order is a `Map`.
 */

/** A value {@link jsonText} can write: a `Map` is a JSON object that keeps its insertion order. */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | ReadonlyMap<string, JsonValue>;

const ESCAPES: ReadonlyMap<string, string> = new Map([
  ['"', '\\"'],
  ["\\", "\\\\"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
  ["\b", "\\b"],
  ["\f", "\\f"],
]);

/** A JSON string literal with every character outside printable ASCII written as `\uXXXX`. */
function quote(text: string): string {
  let body = "";
  for (let index = 0; index < text.length; index++) {
    const character = text.charAt(index);
    const code = text.charCodeAt(index);
    body +=
      ESCAPES.get(character) ??
      (code >= 0x20 && code <= 0x7e ? character : `\\u${code.toString(16).padStart(4, "0")}`);
  }
  return `"${body}"`;
}

function isList(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function isObject(value: JsonValue): value is ReadonlyMap<string, JsonValue> {
  return value instanceof Map;
}

function write(value: JsonValue, depth: number): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new RangeError(`${String(value)} is not a whole number`);
    return String(value);
  }
  if (typeof value === "string") return quote(value);
  const inner = "  ".repeat(depth + 1);
  const outer = "  ".repeat(depth);
  if (isObject(value)) {
    if (value.size === 0) return "{}";
    const members = Array.from(
      value,
      ([key, member]) => `${inner}${quote(key)}: ${write(member, depth + 1)}`,
    );
    return `{\n${members.join(",\n")}\n${outer}}`;
  }
  if (!isList(value)) throw new TypeError("a JSON object must be a Map");
  if (value.length === 0) return "[]";
  return `[\n${value.map((item) => `${inner}${write(item, depth + 1)}`).join(",\n")}\n${outer}]`;
}

/**
 * Writes `value` as indented JSON, two spaces per level, with no trailing newline.
 *
 * @throws RangeError for a number that is not a whole number, which no saved document holds.
 */
export function jsonText(value: JsonValue): string {
  return write(value, 0);
}

function writeCompact(value: JsonValue): string {
  if (isObject(value)) {
    return `{${Array.from(value, ([key, member]) => `${quote(key)}: ${writeCompact(member)}`).join(", ")}}`;
  }
  if (isList(value)) return `[${value.map(writeCompact).join(", ")}]`;
  return write(value, 0);
}

/**
 * Writes `value` as a single line the way Python's `json.dumps(value)` does: `, ` between members, `: ` after a key and every character outside printable ASCII escaped.
 *
 * @throws RangeError for a number that is not a whole number.
 */
export function compactJsonText(value: JsonValue): string {
  return writeCompact(value);
}
