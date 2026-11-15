/** A scripted ELM327 adapter on a K-line bus, with units that answer by address. */

import {
  ScriptedTransport,
  asciiDecode,
  asciiEncode,
  checksum,
  concatBytes,
  toUpperHex,
} from "../../src/core/index.js";

/** A K-line unit takes one request payload and returns the reply payload, or `undefined` to stay silent. */
export type KLineUnit = (request: Uint8Array) => Uint8Array | undefined;

/** One reply as the adapter prints it with headers on: format, target, source, data, checksum. */
export function replyLine(
  source: number,
  payload: Uint8Array,
  options: { readonly tester?: number; readonly corrupt?: boolean } = {},
): string {
  const body = concatBytes(Uint8Array.of(0x48, options.tester ?? 0xf1, source), payload);
  const final = (checksum(body) + (options.corrupt === true ? 1 : 0)) & 0xff;
  return toUpperHex(concatBytes(body, Uint8Array.of(final)));
}

/** The adapter's command interpreter on a K-line bus. */
export class FakeKLineCore {
  readonly sent: string[] = [];
  target = 0;
  corrupt = false;
  private partial = "";

  constructor(
    readonly units: Record<number, KLineUnit>,
    private readonly silentInit: ReadonlySet<number> = new Set(),
  ) {}

  /** Takes the bytes the tool wrote and returns the bytes the adapter would send back. */
  feed(data: Uint8Array): Uint8Array {
    this.partial += asciiDecode(data);
    let output = "";
    for (let end = this.partial.indexOf("\r"); end >= 0; end = this.partial.indexOf("\r")) {
      const line = this.partial.slice(0, end);
      this.partial = this.partial.slice(end + 1);
      output += `${this.handle(line.trim().toUpperCase())}\r\r>`;
    }
    return asciiEncode(output);
  }

  private handle(line: string): string {
    this.sent.push(line);
    if (line === "ATZ") return "ELM327 v2.3";
    if (line === "ATI" || line === "AT@1") return "ELM327 v2.3";
    if (line === "STI") return "?";
    if (line === "ATRV") return "12.4V";
    if (line.startsWith("ATSH")) {
      this.target = Number.parseInt(line.slice(6, 8), 16);
      return "OK";
    }
    if (line === "ATSI" || line === "ATFI") {
      return this.silentInit.has(this.target) ? "BUS INIT: ERROR" : "BUS INIT: OK";
    }
    if (line.startsWith("AT") || line.startsWith("ST")) return "OK";
    const unit = this.units[this.target];
    const reply = unit?.(
      Uint8Array.from(line.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16)),
    );
    if (reply === undefined) return "NO DATA";
    return replyLine(this.target, reply, { corrupt: this.corrupt });
  }

  /** Every line that was a diagnostic request, not an adapter command. */
  get requests(): string[] {
    return this.sent.filter((line) => !line.startsWith("AT") && !line.startsWith("ST"));
  }
}

/** An in-process adapter link backed by a {@link FakeKLineCore}. */
export function fakeKLineTransport(core: FakeKLineCore): ScriptedTransport {
  return new ScriptedTransport((written) => core.feed(written));
}
