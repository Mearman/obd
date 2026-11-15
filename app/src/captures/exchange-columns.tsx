import { describeAddress, describeOutcome, type Exchange } from "obd-read";
import type { Column } from "../ui";

/** The columns of a table of raw exchanges: sequence number, address, request and the reply as the adapter gave it. */
export const RAW_COLUMNS: readonly Column<Exchange>[] = [
  { header: "#", render: (exchange) => String(exchange.seq) },
  { header: "Address", render: (exchange) => describeAddress(exchange.address) },
  { header: "Request", render: (exchange) => <code>{exchange.request}</code> },
  { header: "Reply (raw)", render: (exchange) => <code>{describeOutcome(exchange)}</code> },
];
