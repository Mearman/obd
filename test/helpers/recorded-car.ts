/** A fake car on the functional address that answers from recorded replies, for tests. */

import {
  Elm,
  FUNCTIONAL_ID,
  obdReport,
  readAddressedObdScan,
  type ObdScan,
} from "../../src/core/index.js";
import { FakeElmCore, fakeTransport } from "./fake-elm.js";
import { responder, type Replies } from "./transcripts.js";

/** The recorded transcripts of one real car (a 2009 petrol hatchback) that tests replay. */
export const RECORDED = ["a150-modes-01-to-09.txt", "a150-since-clear.txt"];

/** A fake car on the functional address that answers from recorded replies. */
export class Car {
  readonly core: FakeElmCore;
  private readonly transport;
  readonly lines: string[] = [];

  constructor(replies: Replies) {
    this.core = new FakeElmCore({ 0x7df: responder(replies) });
    this.transport = fakeTransport(this.core);
  }

  /** Runs the `obd` command's report on a session that is on the bus and addressed functionally. */
  async obd(): Promise<number> {
    return obdReport(await this.elm(), (line) => this.lines.push(line));
  }

  /** Reads the structured scan on a session that is on the bus and addressed functionally. */
  async scan(): Promise<ObdScan> {
    return readAddressedObdScan(await this.elm());
  }

  async elm(): Promise<Elm> {
    const elm = new Elm(this.transport);
    await elm.selectCan(11, 500_000);
    await elm.addressFunctional(FUNCTIONAL_ID[11]);
    return elm;
  }

  get output(): string {
    return this.lines.join("\n");
  }
}
