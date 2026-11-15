import { describe, expect, it } from "vitest";
import {
  DIALECTS,
  TabularError,
  formatRow,
  formatTable,
  parseTable,
  renderTable,
  type Dialect,
  type TableSpec,
} from "../src/core/index.js";

/** A byte order mark, built so no editor or formatter can drop it. */
const BOM = String.fromCharCode(0xfeff);

/** Strings that break naive delimited writers. */
const AWKWARD = [
  "",
  " ",
  "plain",
  "a,b",
  'say "hi"',
  '"',
  '""',
  "tab\there",
  "line\nfeed",
  "carriage\rreturn",
  "crlf\r\nbreak",
  "back\\slash",
  "\\t is not a tab",
  "ends with backslash\\",
  "\\",
  "=1+1",
  "+44 20 7946 0000",
  "-1",
  "@SUM(A1)",
  "unicode: éü 中文 \u{1f697}",
  BOM + "inner bom",
  "trailing space ",
  "  leading space",
];

/** A small deterministic generator, so a failing case is reproducible from its seed. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

const ALPHABET = [",", '"', "\t", "\n", "\r", "\\", "a", "Z", "0", " ", "=", "é", "中"];

function randomValue(next: () => number): string {
  const length = Math.floor(next() * 8);
  return Array.from({ length }, () => ALPHABET[Math.floor(next() * ALPHABET.length)] ?? "").join(
    "",
  );
}

describe.each(DIALECTS)("%s", (dialect: Dialect) => {
  it("reads back every awkward value in every position", () => {
    const rows = AWKWARD.map((value) => [value, "x", value]);
    const text = formatTable(dialect, ["a", "b", "c"], rows);
    expect(parseTable(dialect, text)).toEqual([["a", "b", "c"], ...rows]);
  });

  it("reads back a table of one column, including empty values", () => {
    const rows = AWKWARD.map((value) => [value]);
    expect(parseTable(dialect, formatTable(dialect, ["only"], rows))).toEqual([["only"], ...rows]);
  });

  it("reads back random tables", () => {
    const next = generator(dialect === "csv" ? 1 : 2);
    for (let table = 0; table < 200; table += 1) {
      const width = 1 + Math.floor(next() * 4);
      const header = Array.from({ length: width }, () => randomValue(next));
      const rows = Array.from({ length: Math.floor(next() * 5) }, () =>
        Array.from({ length: width }, () => randomValue(next)),
      );
      expect(parseTable(dialect, formatTable(dialect, header, rows))).toEqual([header, ...rows]);
    }
  });

  it("leaves a leading formula character as it is", () => {
    const row = ["=1+1", "+1", "-1", "@x"];
    const text = formatRow(dialect, row);
    expect(text.startsWith(dialect === "csv" ? "=1+1,+1,-1,@x" : "=1+1\t+1\t-1\t@x")).toBe(true);
  });

  it("writes UTF-8 without a byte order mark and reads one if present", () => {
    const text = formatTable(dialect, ["h"], [["é"]]);
    expect(text.startsWith(BOM)).toBe(false);
    expect(parseTable(dialect, BOM + text)).toEqual([["h"], ["é"]]);
  });

  it("accepts a final record with no terminator", () => {
    const text = formatTable(dialect, ["a", "b"], [["1", "2"]]);
    expect(parseTable(dialect, text.replace(/\r?\n$/, ""))).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("csv", () => {
  it("is RFC 4180: CRLF records, quotes on comma, quote, CR and LF, quotes doubled", () => {
    expect(
      formatTable(
        "csv",
        ["a", "b"],
        [
          ["x,y", 'q"r'],
          ["l\nf", "c\rr"],
          ["", ""],
        ],
      ),
    ).toBe('a,b\r\n"x,y","q""r"\r\n"l\nf","c\rr"\r\n,\r\n');
  });

  it("writes a record of one empty field as a quoted pair and reads it back", () => {
    expect(formatRow("csv", [""])).toBe('""\r\n');
    expect(parseTable("csv", '""\r\n')).toEqual([[""]]);
  });

  it("reads LF records and skips blank lines", () => {
    expect(parseTable("csv", "a,b\n1,2\n\n3,4\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("refuses an unterminated quote and text after a closing quote", () => {
    expect(() => parseTable("csv", 'a\n"open')).toThrow(TabularError);
    expect(() => parseTable("csv", '"a"b\n')).toThrow(/after a closing quote/);
  });
});

describe("tsv", () => {
  it("escapes tab, line feed, carriage return and backslash and ends records with LF", () => {
    expect(formatRow("tsv", ["a\tb", "c\nd", "e\rf", "g\\h"])).toBe(
      "a\\tb\tc\\nd\te\\rf\tg\\\\h\n",
    );
  });

  it("never quotes", () => {
    expect(formatRow("tsv", ['say "hi"', "a,b"])).toBe('say "hi"\ta,b\n');
  });

  it("reads CRLF records", () => {
    expect(parseTable("tsv", "a\tb\r\n1\t2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("refuses an escape it does not write, naming the record", () => {
    expect(() => parseTable("tsv", "a\nb\\x\n")).toThrow(/unknown escape \\x in record 2/);
    expect(() => parseTable("tsv", "a\\\n")).toThrow(TabularError);
  });
});

describe("renderTable", () => {
  const spec: TableSpec<{ readonly name: string; readonly n: number }> = {
    columns: [
      { header: "name", cell: (row) => row.name },
      { header: "n", cell: (row) => String(row.n) },
    ],
  };
  const rows = [
    { name: "a,b", n: 1 },
    { name: "c\td", n: 2 },
  ];

  it("writes the same cells in each format", () => {
    expect(renderTable("csv", spec, rows)).toBe('name,n\r\n"a,b",1\r\nc\td,2\r\n');
    expect(renderTable("tsv", spec, rows)).toBe("name\tn\na,b\t1\nc\\td\t2\n");
    expect(JSON.parse(renderTable("json", spec, rows))).toEqual([
      { name: "a,b", n: "1" },
      { name: "c\td", n: "2" },
    ]);
  });

  it("writes a header alone for no rows", () => {
    expect(renderTable("tsv", spec, [])).toBe("name\tn\n");
    expect(JSON.parse(renderTable("json", spec, []))).toEqual([]);
  });
});
