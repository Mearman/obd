/**
 * The exchanges of a capture packed into columns of bytes, so a share link carries a raw capture in a fraction of its JSON size, and unpacked back to exactly the same exchanges.
 *
 * A capture's JSON spends most of its bytes on what repeats: field names, the bus and addressing of every exchange, absolute times, hexadecimal text, and the many identical outcomes of a discovery sweep. Here every field of every exchange goes into a stream of its own, so the compressor sees long runs of like values:
 *
 * - `seq` as the gap to the previous number less one, `at` as the signed difference from the previous time (the first from the capture's start), split into a low-byte and a high-byte stream.
 * - The bus and the protocol as indexes into tables of the distinct values, and every outcome text (error class and message) as an index into a table of distinct texts; the tables travel with the capture's other fields as JSON, so every string keeps its exact code units.
 * - The address as its form, the request identifier as the difference from the previous exchange's, the response identifier as the difference from the request identifier, and the extended address as a byte.
 * - Each distinct request once, as bytes, and each exchange's request as an index into those.
 * - Each reply message as bytes, with the part it repeats of the request left out: a positive reply's service byte (the request's plus `0x40`) and the request bytes it echoes, or a negative reply's `7F` and the refused service.
 *
 * {@link packExchanges} and {@link unpackExchanges} are inverses for any exchanges the capture schema accepts. Unpacking never throws: malformed input is `undefined`, and it stops as soon as the exchanges it has built would pass the caller's limit on their JSON size, so a small packed form cannot expand without bound. This module is platform-free.
 */

import type { Exchange, ExchangeAddress, ExchangeBus, ExchangeOutcome } from "./exchange.js";

/** A positive reply's service byte is the request's plus this. */
const POSITIVE_OFFSET = 0x40;

/** The service byte of a negative response. */
const NEGATIVE_RESPONSE = 0x7f;

/** How a reply message relates to its request: written whole, as a negative response to it, or as a positive reply echoing this many of its leading bytes ({@link SHAPE_ECHO} plus the count). */
const SHAPE_LITERAL = 0;
const SHAPE_NEGATIVE = 1;
const SHAPE_ECHO = 2;

/** The address forms, with which of a physical address's optional fields are present. */
const ADDRESS_NONE = 0;
const ADDRESS_FUNCTIONAL_DEFAULT = 1;
const ADDRESS_FUNCTIONAL = 2;
const ADDRESS_PHYSICAL = 3;
const PHYSICAL_NO_RESPONSE_ID = 1;
const PHYSICAL_NO_EXTENDED = 2;
const ADDRESS_ANY_REPLY = 7;

/** The outcome kinds, in the order the packed form numbers them. */
const OUTCOME_KINDS = ["replies", "no-response", "adapter-error", "transport-error"] as const;

/** The streams of the packed form, in the order they are written. */
const STREAMS = [
  "seq",
  "atLow",
  "atHigh",
  "session",
  "bus",
  "protocol",
  "address",
  "requestId",
  "responseId",
  "extended",
  "request",
  "requestShared",
  "requestLength",
  "requestBytes",
  "outcome",
  "text",
  "senders",
  "sender",
  "messages",
  "shape",
  "length",
  "data",
] as const;

type StreamName = (typeof STREAMS)[number];

/** The tables a packed form refers to by index; they are JSON values, so they travel with the capture's other fields. */
export interface PackTables {
  readonly buses: readonly ExchangeBus[];
  readonly protocols: readonly Exchange["protocol"][];
  readonly texts: readonly string[];
}

/** What {@link packExchanges} gives: the tables and the packed streams. */
export interface PackedExchanges {
  readonly tables: PackTables;
  readonly bytes: Uint8Array;
}

class Writer {
  private readonly out: number[] = [];

  byte(value: number): void {
    this.out.push(value);
  }

  bytes(values: Uint8Array): void {
    for (const value of values) this.out.push(value);
  }

  /** A non-negative safe integer, seven bits a byte, low bits first. */
  unsigned(value: number): void {
    let rest = value;
    while (rest >= 0x80) {
      this.out.push((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.out.push(rest);
  }

  /** An integer of either sign whose magnitude is below 2^52: the magnitude doubled, plus one for a negative value. Identifiers are at most 29 bits, so their differences always fit. */
  signed(value: number): void {
    this.unsigned(value < 0 ? -value * 2 - 1 : value * 2);
  }

  get length(): number {
    return this.out.length;
  }

  result(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

/** A cursor over bytes; every read past the end, or of a number that is not a safe integer, sets {@link failed} and gives 0. */
class Reader {
  private offset = 0;
  failed = false;

  constructor(private readonly input: Uint8Array) {}

  byte(): number {
    const value = this.input[this.offset];
    if (value === undefined) {
      this.failed = true;
      return 0;
    }
    this.offset += 1;
    return value;
  }

  bytes(count: number): Uint8Array {
    if (this.offset + count > this.input.length) {
      this.failed = true;
      return new Uint8Array(0);
    }
    const out = this.input.slice(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }

  unsigned(): number {
    let value = 0;
    let scale = 1;
    for (;;) {
      const next = this.byte();
      if (this.failed) return 0;
      value += (next & 0x7f) * scale;
      if (value > Number.MAX_SAFE_INTEGER) {
        this.failed = true;
        return 0;
      }
      if ((next & 0x80) === 0) {
        // A zero final byte after the first is a longer spelling of the same number; only the shortest is read, so one capture has one packed form.
        if (next === 0 && scale > 1) this.failed = true;
        return value;
      }
      scale *= 0x80;
    }
  }

  signed(): number {
    const value = this.unsigned();
    // The magnitude of an odd value is (value + 1) / 2; adding one to an odd safe integer stays exact.
    return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
  }

  get done(): boolean {
    return this.offset === this.input.length;
  }
}

function hexOf(bytes: Uint8Array): string {
  let out = "";
  for (const value of bytes) out += value.toString(16).toUpperCase().padStart(2, "0");
  return out;
}

function bytesOf(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(hex.slice(2 * index, 2 * index + 2), 16);
  }
  return out;
}

/** The index of `value` in `table` by JSON equality, adding it when it is new. */
function indexIn<T>(table: T[], keys: Map<string, number>, value: T): number {
  const key = JSON.stringify(value);
  const known = keys.get(key);
  if (known !== undefined) return known;
  table.push(value);
  keys.set(key, table.length - 1);
  return table.length - 1;
}

/** How many leading bytes of `request` a positive reply `message` echoes after its service byte, counting the service byte, or 0 when it is not a positive reply to it. */
function echoed(request: Uint8Array, message: Uint8Array): number {
  const service = request[0];
  if (service === undefined || service + POSITIVE_OFFSET > 0xff) return 0;
  if (message[0] !== service + POSITIVE_OFFSET) return 0;
  let count = 1;
  while (count < request.length && count < message.length && message[count] === request[count]) {
    count += 1;
  }
  return count;
}

/** How many leading bytes `first` and `second` have in common. */
function commonPrefix(first: Uint8Array, second: Uint8Array): number {
  let count = 0;
  while (count < first.length && count < second.length && first[count] === second[count]) {
    count += 1;
  }
  return count;
}

function addressForm(address: ExchangeAddress): number {
  if (address === null) return ADDRESS_NONE;
  switch (address.mode) {
    case "functional":
      return address.requestId === null ? ADDRESS_FUNCTIONAL_DEFAULT : ADDRESS_FUNCTIONAL;
    case "physical":
      return (
        ADDRESS_PHYSICAL +
        (address.responseId === null ? PHYSICAL_NO_RESPONSE_ID : 0) +
        (address.extendedAddress === null ? PHYSICAL_NO_EXTENDED : 0)
      );
    case "any-reply":
      return ADDRESS_ANY_REPLY;
  }
}

function requestIdOf(address: ExchangeAddress): number | null {
  return address === null ? null : address.requestId;
}

/**
 * The exchanges of a capture that starts at `startedAt`, packed. The exchanges must be ones the capture schema accepts (upper-case hexadecimal, increasing sequence numbers, integer times and identifiers).
 */
export function packExchanges(exchanges: readonly Exchange[], startedAt: number): PackedExchanges {
  const streams = new Map<StreamName, Writer>(STREAMS.map((name) => [name, new Writer()]));
  const stream = (name: StreamName): Writer => {
    const found = streams.get(name);
    if (found === undefined) throw new RangeError(`no stream ${name}`);
    return found;
  };
  const buses: ExchangeBus[] = [];
  const busKeys = new Map<string, number>();
  const protocols: Exchange["protocol"][] = [];
  const protocolKeys = new Map<string, number>();
  const texts: string[] = [];
  const textKeys = new Map<string, number>();
  const requests = new Map<string, number>();
  let previousSeq = -1;
  let previousAt = startedAt;
  let previousRequestId = 0;
  let previousNew: Uint8Array = new Uint8Array(0);

  for (const exchange of exchanges) {
    stream("seq").unsigned(exchange.seq - previousSeq - 1);
    previousSeq = exchange.seq;
    const gap = exchange.at - previousAt;
    previousAt = exchange.at;
    // The gaps of a recording are similar from one exchange to the next, so the sign with the low seven bits and the rest go to separate streams, where each repeats more. The magnitude is never doubled, so any gap between two safe integers is written exactly.
    const magnitude = Math.abs(gap);
    stream("atLow").byte((magnitude % 0x80) * 2 + (gap < 0 ? 1 : 0));
    stream("atHigh").unsigned(Math.floor(magnitude / 0x80));
    stream("session").unsigned(exchange.session);
    stream("bus").unsigned(indexIn(buses, busKeys, exchange.bus));
    stream("protocol").unsigned(indexIn(protocols, protocolKeys, exchange.protocol));

    const { address } = exchange;
    stream("address").byte(addressForm(address));
    const requestId = requestIdOf(address);
    if (requestId !== null) {
      stream("requestId").signed(requestId - previousRequestId);
      previousRequestId = requestId;
    }
    if (address !== null && address.mode === "physical") {
      if (address.responseId !== null)
        stream("responseId").signed(address.responseId - address.requestId);
      if (address.extendedAddress !== null) stream("extended").byte(address.extendedAddress);
    }

    const known = requests.get(exchange.request);
    // 0 is a request not seen before; otherwise how far back in the list of distinct requests it is, so a repeated request is the same small number each time.
    stream("request").unsigned(known === undefined ? 0 : requests.size - known);
    const request = bytesOf(exchange.request);
    if (known === undefined) {
      requests.set(exchange.request, requests.size);
      // A new request is written as the bytes it shares with the start of the one before it, then the rest: successive reads differ in their last bytes.
      const shared = commonPrefix(previousNew, request);
      stream("requestShared").unsigned(shared);
      stream("requestLength").unsigned(request.length - shared);
      stream("requestBytes").bytes(request.subarray(shared));
      previousNew = request;
    }

    const { outcome } = exchange;
    stream("outcome").byte(OUTCOME_KINDS.indexOf(outcome.kind));
    if (outcome.kind === "replies") {
      stream("senders").unsigned(outcome.replies.length);
      for (const reply of outcome.replies) {
        stream("sender").signed(reply.sender - (requestId ?? 0));
        stream("messages").unsigned(reply.messages.length);
        for (const text of reply.messages) {
          const message = bytesOf(text);
          const echo = echoed(request, message);
          const negative =
            echo === 0 &&
            message.length >= 2 &&
            message[0] === NEGATIVE_RESPONSE &&
            message[1] === request[0];
          const skipped = echo > 0 ? echo : negative ? 2 : 0;
          stream("shape").unsigned(
            echo > 0 ? SHAPE_ECHO + echo - 1 : negative ? SHAPE_NEGATIVE : SHAPE_LITERAL,
          );
          stream("length").unsigned(message.length - skipped);
          stream("data").bytes(message.subarray(skipped));
        }
      }
    } else {
      if (outcome.kind !== "no-response") {
        stream("text").unsigned(indexIn(texts, textKeys, outcome.error));
      }
      stream("text").unsigned(indexIn(texts, textKeys, outcome.message));
    }
  }

  const out = new Writer();
  out.unsigned(exchanges.length);
  for (const name of STREAMS) {
    const written = stream(name);
    out.unsigned(written.length);
    out.bytes(written.result());
  }
  return { tables: { buses, protocols, texts }, bytes: out.result() };
}

/** The JSON size of one exchange as the canonical form writes it, for the caller's limit. */
export type ExchangeSize = (exchange: Exchange) => number;

/**
 * The exchanges {@link packExchanges} packed, or `undefined` when `bytes` are not a packed form of exchanges with these tables: a stream that ends early or has bytes left over, an index past its table, a number that is not a safe integer, or a value the exchange schema would not hold in that field's shape.
 *
 * Stops with `{tooLarge: true}` as soon as the sizes `sizeOf` gives for the exchanges built so far add up to more than `budget`. The caller validates the result against the capture schema.
 */
export function unpackExchanges(
  bytes: Uint8Array,
  tables: PackTables,
  startedAt: number,
  budget: number,
  sizeOf: ExchangeSize,
): { readonly exchanges: Exchange[] } | { readonly tooLarge: true } | undefined {
  const outer = new Reader(bytes);
  const count = outer.unsigned();
  const streams = new Map<StreamName, Reader>();
  for (const name of STREAMS) streams.set(name, new Reader(outer.bytes(outer.unsigned())));
  if (outer.failed || !outer.done) return undefined;
  const stream = (name: StreamName): Reader => {
    const found = streams.get(name);
    if (found === undefined) throw new RangeError(`no stream ${name}`);
    return found;
  };

  const requests: string[] = [];
  const requestBytes: Uint8Array[] = [];
  const exchanges: Exchange[] = [];
  let spent = 0;
  let previousSeq = -1;
  let previousAt = startedAt;
  let previousRequestId = 0;
  const failed = (): boolean => STREAMS.some((name) => stream(name).failed);

  for (let index = 0; index < count; index++) {
    const seq = previousSeq + 1 + stream("seq").unsigned();
    previousSeq = seq;
    const low = stream("atLow").byte();
    const magnitude = stream("atHigh").unsigned() * 0x80 + (low >> 1);
    // A negative zero is a second spelling of no gap; only one is read.
    if ((low & 1) === 1 && magnitude === 0) return undefined;
    const at = previousAt + ((low & 1) === 1 ? -magnitude : magnitude);
    previousAt = at;
    const session = stream("session").unsigned();
    const bus = tables.buses[stream("bus").unsigned()];
    const protocol = tables.protocols[stream("protocol").unsigned()];
    if (bus === undefined || protocol === undefined) return undefined;

    const form = stream("address").byte();
    let address: ExchangeAddress;
    if (form === ADDRESS_NONE) address = null;
    else if (form === ADDRESS_FUNCTIONAL_DEFAULT) address = { mode: "functional", requestId: null };
    else {
      const requestId = previousRequestId + stream("requestId").signed();
      previousRequestId = requestId;
      if (form === ADDRESS_FUNCTIONAL) address = { mode: "functional", requestId };
      else if (form === ADDRESS_ANY_REPLY) address = { mode: "any-reply", requestId };
      else if (form >= ADDRESS_PHYSICAL && form < ADDRESS_ANY_REPLY) {
        const flags = form - ADDRESS_PHYSICAL;
        const responseId =
          (flags & PHYSICAL_NO_RESPONSE_ID) === 0
            ? requestId + stream("responseId").signed()
            : null;
        const extendedAddress =
          (flags & PHYSICAL_NO_EXTENDED) === 0 ? stream("extended").byte() : null;
        address = { mode: "physical", requestId, responseId, extendedAddress };
      } else return undefined;
    }

    const distance = stream("request").unsigned();
    if (distance === 0) {
      const shared = stream("requestShared").unsigned();
      const rest = stream("requestBytes").bytes(stream("requestLength").unsigned());
      const previous = requestBytes.at(-1) ?? new Uint8Array(0);
      if (shared > previous.length) return undefined;
      // Sharing a byte more than the previous request does would be a longer spelling of the same request; only the shortest is read.
      if (rest.length > 0 && shared < previous.length && rest[0] === previous[shared])
        return undefined;
      const read = new Uint8Array(shared + rest.length);
      read.set(previous.subarray(0, shared), 0);
      read.set(rest, shared);
      if (requests.includes(hexOf(read))) return undefined;
      requestBytes.push(read);
      requests.push(hexOf(read));
    }
    const requestIndex = distance === 0 ? requests.length - 1 : requests.length - distance;
    const request = requests[requestIndex];
    const requestData = requestBytes[requestIndex];
    if (request === undefined || requestData === undefined) return undefined;
    const requestId = requestIdOf(address);

    const kind = OUTCOME_KINDS[stream("outcome").byte()];
    let outcome: ExchangeOutcome;
    if (kind === undefined) return undefined;
    if (kind === "replies") {
      const senders = stream("senders").unsigned();
      const replies: { sender: number; messages: string[] }[] = [];
      for (let sender = 0; sender < senders && !failed(); sender++) {
        const id = (requestId ?? 0) + stream("sender").signed();
        const total = stream("messages").unsigned();
        const messages: string[] = [];
        for (let message = 0; message < total && !failed(); message++) {
          const shape = stream("shape").unsigned();
          const rest = stream("data").bytes(stream("length").unsigned());
          let prefix: Uint8Array;
          if (shape === SHAPE_LITERAL) prefix = new Uint8Array(0);
          else if (shape === SHAPE_NEGATIVE) {
            const service = requestData[0];
            if (service === undefined) return undefined;
            prefix = Uint8Array.of(NEGATIVE_RESPONSE, service);
          } else {
            const echo = shape - SHAPE_ECHO + 1;
            const service = requestData[0];
            if (service === undefined || echo > requestData.length) return undefined;
            prefix = Uint8Array.of(service + POSITIVE_OFFSET, ...requestData.subarray(1, echo));
          }
          messages.push(hexOf(prefix) + hexOf(rest));
        }
        replies.push({ sender: id, messages });
      }
      outcome = { kind, replies };
    } else {
      const error = kind === "no-response" ? undefined : tables.texts[stream("text").unsigned()];
      const message = tables.texts[stream("text").unsigned()];
      if (message === undefined) return undefined;
      if (kind === "no-response") outcome = { kind, message };
      else if (kind === "adapter-error") {
        if (error !== "ElmError" && error !== "AdapterUnsupported") return undefined;
        outcome = { kind, error, message };
      } else {
        if (error !== "TransportError" && error !== "TransportTimeout") return undefined;
        outcome = { kind, error, message };
      }
    }
    if (failed()) return undefined;

    const exchange: Exchange = { seq, at, session, bus, address, protocol, request, outcome };
    spent += sizeOf(exchange) + 1;
    if (spent > budget) return { tooLarge: true };
    exchanges.push(exchange);
  }
  if (failed() || !STREAMS.every((name) => stream(name).done)) return undefined;
  return { exchanges };
}
