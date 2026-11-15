import { describe, expect, it } from "vitest";
import { CsvLog, csvRow, type CsvSink } from "../src/core/index.js";

class MemorySink implements CsvSink {
  readonly writes: string[] = [];
  closed = false;

  write(text: string): Promise<void> {
    this.writes.push(text);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

describe("csvRow", () => {
  it("separates fields with commas and ends with CRLF", () => {
    expect(csvRow(["a", "b"])).toBe("a,b\r\n");
  });

  it("quotes fields holding a comma, a quote or a line break", () => {
    expect(csvRow(["a,b", 'say "hi"', "two\nlines", "cr\rhere", "plain"])).toBe(
      '"a,b","say ""hi""","two\nlines","cr\rhere",plain\r\n',
    );
  });

  it("writes a lone empty field as a quoted pair so it is not a blank line", () => {
    expect(csvRow([""])).toBe('""\r\n');
    expect(csvRow(["", ""])).toBe(",\r\n");
  });
});

describe("CsvLog", () => {
  it("writes the header, then each row as it is given", async () => {
    const sink = new MemorySink();
    const log = await CsvLog.create(sink, ["a", "b"]);
    expect(sink.writes).toEqual(["a,b\r\n"]);
    await log.write(["1", "2"]);
    expect(sink.writes).toEqual(["a,b\r\n", "1,2\r\n"]);
    await log.close();
    expect(sink.closed).toBe(true);
  });
});
