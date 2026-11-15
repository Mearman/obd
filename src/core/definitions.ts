/**
 * Read code and value names from diagnostic definition files the user supplies.
 *
 * Nothing here ships a maker's data: every function reads the bytes it is given and returns what they say. Two forms are understood:
 *
 * - ODX (ISO 22901-1), as a single XML file or inside a PDX archive: DTC entries give fault-code texts, and a DIAG-SERVICE whose request is made of constant bytes gives a name for that request.
 * - The JSON written by Trafo from CaesarSuite (MIT, https://github.com/jglim/CaesarSuite), which converts a Mercedes CBF file to JSON: its `DTCs` give fault-code texts and its `DiagServices` give names for their request bytes. `obd-read` does not read CBF directly and does not depend on CaesarSuite.
 *
 * This module is platform-free: it takes file contents as bytes and a file name for its suffix and messages.
 */

import { XMLParser } from "fast-xml-parser";
import { SyntaxValidator } from "fast-xml-validator";
import { unzipSync } from "fflate";
import { CodeNameError, normaliseCode } from "./codenames.js";

// Core's type libraries include neither the DOM nor Node, but every platform provides this standard decoder, so declare the part used.
declare const TextDecoder: new (
  label: string,
  options: { fatal: boolean },
) => { decode(input: Uint8Array): string };

/** A PDX member larger than this is refused rather than inflated into memory. */
export const MAX_MEMBER_BYTES = 256 * 1024 * 1024;

/** The ODX element names that are diagnostic layers. */
export const ODX_LAYERS: ReadonlySet<string> = new Set([
  "BASE-VARIANT",
  "ECU-VARIANT",
  "PROTOCOL",
  "FUNCTIONAL-GROUP",
  "ECU-SHARED-DATA",
]);

/** The file-name suffixes of ODX documents inside a PDX archive. */
export const ODX_SUFFIXES: readonly string[] = [".odx", ".odx-d", ".odx-c", ".odx-v", ".xml"];

/** A definition file cannot be read or is not in a form this tool understands. */
export class DefinitionError extends Error {
  override name = "DefinitionError";
}

/** Names read from one definition file. */
export class Definitions {
  /** Fault-code texts by normalised code. */
  readonly codes = new Map<string, string>();

  /** Request names by upper-case hexadecimal request bytes. */
  readonly values = new Map<string, string>();

  /** Entries that could not be used, each with the reason. */
  readonly skipped: string[] = [];

  /** Entries whose text differed from one already kept, each saying which was kept. */
  readonly conflicts: string[] = [];

  /** Records a fault code's text; blank text is skipped and differing text for a known code is a conflict, first kept. */
  addCode(code: string, text: string): void {
    this.add(this.codes, code, text, "fault code");
  }

  /** Records a request's name; blank text is skipped and a differing name for a known request is a conflict, first kept. */
  addValue(request: string, name: string): void {
    this.add(this.values, request, name, "request");
  }

  private add(table: Map<string, string>, key: string, raw: string, kind: string): void {
    const text = raw.split(/\s+/).filter(Boolean).join(" ");
    const kept = table.get(key);
    if (text === "") this.skipped.push(`${kind} ${key}: no text`);
    else if (kept === undefined) table.set(key, text);
    else if (kept !== text) {
      this.conflicts.push(`${kind} ${key}: kept ${quote(kept)}, ignored ${quote(text)}`);
    }
  }
}

/** Python-style single-quoted repr of text, as the tool's messages have always shown it. */
function quote(text: string): string {
  return text.includes("'") && !text.includes('"')
    ? `"${text}"`
    : `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

interface XmlElement {
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string>>;
  /** The text before the first child element, untrimmed. */
  readonly text: string;
  readonly children: readonly XmlElement[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Elements and text of one node list from the parser's ordered output. */
function toElements(nodes: unknown): { elements: XmlElement[]; leadingText: string } {
  const elements: XmlElement[] = [];
  let leadingText = "";
  if (!Array.isArray(nodes)) return { elements, leadingText };
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const attributes: Record<string, string> = {};
    const rawAttributes = node[":@"];
    if (isRecord(rawAttributes)) {
      for (const [name, value] of Object.entries(rawAttributes)) {
        if (typeof value === "string") attributes[name] = value;
      }
    }
    for (const [tag, content] of Object.entries(node)) {
      if (tag === ":@") continue;
      if (tag === "#text") {
        if (elements.length === 0 && typeof content === "string") leadingText += content;
      } else if (!tag.startsWith("?") && !tag.startsWith("!")) {
        const inner = toElements(content);
        elements.push({ tag, attributes, text: inner.leadingText, children: inner.elements });
      }
    }
  }
  return { elements, leadingText };
}

const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
});

function decodeXml(data: Uint8Array, where: string): string {
  let label = "utf-8";
  if (data[0] === 0xff && data[1] === 0xfe) label = "utf-16le";
  else if (data[0] === 0xfe && data[1] === 0xff) label = "utf-16be";
  else {
    const declaration = /^<\?xml[^>]*\sencoding\s*=\s*["']([^"']+)["']/.exec(
      new TextDecoder("latin1", { fatal: false }).decode(data.subarray(0, 200)),
    );
    if (declaration?.[1] !== undefined) label = declaration[1];
  }
  try {
    return new TextDecoder(label, { fatal: true }).decode(data);
  } catch (error) {
    if (error instanceof Error) throw new DefinitionError(`${where}: ${error.message}`);
    throw error;
  }
}

function parseXml(data: Uint8Array, where: string): XmlElement {
  const text = decodeXml(data, where);
  // A definition file has no need of entities; refusing them rules out expansion attacks.
  if (text.includes("<!ENTITY"))
    throw new DefinitionError(`${where}: entity declarations are not accepted`);
  try {
    SyntaxValidator.validate(text);
  } catch (error) {
    if (error instanceof Error) throw new DefinitionError(`${where}: ${error.message}`);
    throw error;
  }
  const { elements } = toElements(xmlParser.parse(text));
  const root = elements[0];
  if (root === undefined) throw new DefinitionError(`${where}: no root element`);
  return root;
}

function localName(tag: string): string {
  return tag.slice(tag.lastIndexOf("}") + 1);
}

function child(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((item) => localName(item.tag) === name);
}

function childText(element: XmlElement, name: string): string {
  return child(element, name)?.text.trim() ?? "";
}

/** The element and every descendant, in document order. */
function* iterate(element: XmlElement): Generator<XmlElement> {
  yield element;
  for (const item of element.children) yield* iterate(item);
}

function hexKey(request: readonly number[]): string {
  return request
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function codeKey(raw: string, definitions: Definitions, where: string): string | undefined {
  try {
    return normaliseCode(raw);
  } catch (error) {
    if (!(error instanceof CodeNameError)) throw error;
    definitions.skipped.push(`${where}: code ${quote(raw)} is not hexadecimal or an SAE code`);
    return undefined;
  }
}

function odxRoots(data: Uint8Array, name: string): XmlElement[] {
  if (!name.toLowerCase().endsWith(".pdx")) return [parseXml(data, name)];
  let members: Record<string, Uint8Array>;
  try {
    members = unzipSync(data, {
      filter: (file) => {
        if (!ODX_SUFFIXES.some((suffix) => file.name.toLowerCase().endsWith(suffix))) return false;
        if (file.originalSize > MAX_MEMBER_BYTES) {
          throw new DefinitionError(`${file.name}: larger than ${String(MAX_MEMBER_BYTES)} bytes`);
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof DefinitionError) throw error;
    if (error instanceof Error)
      throw new DefinitionError(`${name}: not a zip archive: ${error.message}`);
    throw error;
  }
  const entries = Object.entries(members);
  if (entries.length === 0) throw new DefinitionError(`${name}: the archive holds no ODX files`);
  return entries.map(([member, bytes]) => parseXml(bytes, member));
}

/** Each REQUEST's constant bytes by its ID, for requests made only of whole constant bytes. */
function odxRequests(roots: readonly XmlElement[]): Map<string, number[]> {
  const requests = new Map<string, number[]>();
  for (const root of roots) {
    for (const request of iterate(root)) {
      const id = request.attributes.ID;
      if (localName(request.tag) !== "REQUEST" || id === undefined) continue;
      const params = child(request, "PARAMS");
      if (params === undefined) continue;
      const placed = new Map<number, number>();
      let whole = true;
      for (const param of params.children) {
        const coded = childText(param, "CODED-VALUE");
        const length = child(param, "DIAG-CODED-TYPE");
        const position = childText(param, "BYTE-POSITION");
        const bits = length === undefined ? "" : childText(length, "BIT-LENGTH");
        if (
          !(/^\d+$/.test(coded) && /^\d+$/.test(position) && bits === "8") ||
          Number(coded) > 0xff
        ) {
          whole = false;
          break;
        }
        placed.set(Number(position), Number(coded));
      }
      if (!whole || placed.size === 0) continue;
      const bytes: number[] = [];
      for (let index = 0; index < placed.size; index++) {
        const byte = placed.get(index);
        if (byte === undefined) break;
        bytes.push(byte);
      }
      if (bytes.length === placed.size) requests.set(id, bytes);
    }
  }
  return requests;
}

/**
 * Parses a Python-style integer literal as `int(text, 0)` does: decimal without leading zeros, or `0x`, `0o` or `0b` prefixed, with an optional sign. Returns undefined when it is not one.
 */
function parseInteger(text: string): bigint | undefined {
  const match = /^([+-]?)(?:(0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+)|([1-9][0-9]*|0+))$/.exec(
    text.trim(),
  );
  if (match === null) return undefined;
  const magnitude = BigInt(match[2] ?? match[3] ?? "0");
  return match[1] === "-" ? -magnitude : magnitude;
}

/**
 * Fault-code texts and request names from an ODX file or PDX archive.
 *
 * `data` is the file's bytes and `name` its file name, whose `.pdx` suffix selects the archive reader and which labels errors. With `variant`, only the diagnostic layer whose SHORT-NAME matches is read; otherwise every layer is, and differing texts for the same code are reported as conflicts, first kept. Throws {@link DefinitionError} when the file cannot be parsed or no layer matches `variant`.
 */
export function readOdx(data: Uint8Array, name: string, variant?: string): Definitions {
  const roots = odxRoots(data, name);
  const requests = odxRequests(roots);
  const definitions = new Definitions();
  const layers = roots.flatMap((root) =>
    [...iterate(root)].filter(
      (layer) =>
        ODX_LAYERS.has(localName(layer.tag)) &&
        (variant === undefined || childText(layer, "SHORT-NAME") === variant),
    ),
  );
  if (layers.length === 0) {
    throw new DefinitionError(
      `${name}: no diagnostic layer${variant === undefined ? "" : ` named ${variant}`}`,
    );
  }
  for (const layer of layers) {
    const layerName = childText(layer, "SHORT-NAME") || "unnamed layer";
    for (const item of iterate(layer)) {
      const tag = localName(item.tag);
      if (tag === "DTC") {
        const raw = childText(item, "TROUBLE-CODE");
        const number = parseInteger(raw);
        if (number === undefined) {
          definitions.skipped.push(`${layerName}: trouble code ${quote(raw)} is not a number`);
          continue;
        }
        const key = codeKey(number.toString(16).toUpperCase(), definitions, layerName);
        if (key !== undefined) {
          definitions.addCode(key, childText(item, "TEXT") || childText(item, "SHORT-NAME"));
        }
      } else if (tag === "DIAG-SERVICE") {
        const reference = child(item, "REQUEST-REF");
        const request =
          reference === undefined ? undefined : requests.get(reference.attributes["ID-REF"] ?? "");
        if (request !== undefined) {
          definitions.addValue(
            hexKey(request),
            childText(item, "LONG-NAME") || childText(item, "SHORT-NAME"),
          );
        }
      }
    }
  }
  return definitions;
}

/** The first of the texts that is not empty, as Python's `or` chose between strings. */
function firstNonEmpty(...texts: (string | undefined)[]): string | undefined {
  return texts.find((text) => text !== undefined && text !== "");
}

function textField(entry: unknown, key: string): string | undefined {
  if (!isRecord(entry)) return undefined;
  const value = entry[key];
  return typeof value === "string" ? value : undefined;
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Fault-code texts and request names from the JSON Trafo writes for a CBF file.
 *
 * `text` is the JSON and `name` the file name used in errors. With `variant`, only the variant of that name is read. Throws {@link DefinitionError} when the text is not that JSON or no variant matches.
 */
export function readTrafo(text: string, name: string, variant?: string): Definitions {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new DefinitionError(`${name}: ${error.message}`);
    throw error;
  }
  const variants = isRecord(data) ? data.Variants : undefined;
  if (!Array.isArray(variants))
    throw new DefinitionError(`${name}: not Trafo output (no Variants list)`);
  const chosen = variants.filter(
    (entry) => variant === undefined || textField(entry, "VariantName") === variant,
  );
  if (chosen.length === 0) {
    const names = variants
      .map((entry) => textField(entry, "VariantName"))
      .filter((variantName) => variantName !== undefined && variantName !== "")
      .join(", ");
    throw new DefinitionError(`${name}: no variant named ${variant ?? ""}; it has ${names}`);
  }
  const definitions = new Definitions();
  for (const entry of chosen) {
    const where = firstNonEmpty(textField(entry, "VariantName")) ?? "unnamed variant";
    const body = isRecord(entry) ? entry : {};
    for (const dtc of listOf(body.DTCs)) {
      const raw = textField(dtc, "Code");
      const description = textField(dtc, "Desc");
      if (raw === undefined || description === undefined) {
        definitions.skipped.push(`${where}: a DTC entry has no Code or Desc`);
        continue;
      }
      const key = codeKey(raw, definitions, where);
      if (key !== undefined) definitions.addCode(key, description);
    }
    for (const service of listOf(body.DiagServices)) {
      const request = textField(service, "RequestBytes");
      const label = firstNonEmpty(
        textField(service, "Desc"),
        textField(service, "DiagServiceName"),
      );
      if (request === undefined || label === undefined) continue;
      const compact = request.replace(/\s+/g, "").toUpperCase();
      if (/^(?:[0-9A-F]{2})+$/.test(compact)) definitions.addValue(compact, label);
    }
  }
  return definitions;
}

/**
 * Reads a definition file, choosing the reader by the suffix of `name`: `.json` is Trafo, `.cbf` is refused with advice, the rest ODX.
 *
 * `data` is the file's bytes. Throws {@link DefinitionError} as the readers do.
 */
export function readDefinitions(data: Uint8Array, name: string, variant?: string): Definitions {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) {
    let text: string;
    try {
      // A UTF-8 byte-order mark is skipped by the decoder, as Trafo's output may start with one.
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch (error) {
      if (error instanceof Error) throw new DefinitionError(`${name}: ${error.message}`);
      throw error;
    }
    return readTrafo(text, name, variant);
  }
  if (lower.endsWith(".cbf")) {
    throw new DefinitionError(
      `${name}: CBF files are not read directly; convert one with Trafo from CaesarSuite and pass the JSON it writes`,
    );
  }
  return readOdx(data, name, variant);
}
