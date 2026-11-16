import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  decodeAsOf,
  decodedCaptureData,
  exchangeStatus,
  type Capture,
  type Exchange,
} from "obd-read";
import { describe, expect, it, vi } from "vitest";
import { PlaybackView } from "../src/captures/playback/PlaybackView";
import {
  MAX_STRIP_CELLS,
  nextIssue,
  stripCells,
  formatOffset,
} from "../src/captures/playback/strip";
import { buildTimeline } from "obd-read";
import { renderApp } from "./render";
import { simulatedCapture } from "./simulated-capture";

/** Decodes a capture as of a cursor under no profile, the way a viewer's `decodeAt` does. */
function decoder(capture: Capture) {
  return vi.fn(async (count: number) =>
    decodedCaptureData(await decodeAsOf(capture, { kind: "generic" }, count)),
  );
}

async function show(capture: Capture) {
  const decodeAt = decoder(capture);
  const whole = await decodeAt(capture.exchanges.length);
  decodeAt.mockClear();
  await renderApp(<PlaybackView capture={capture} decoded={whole} decodeAt={decodeAt} />);
  return { decodeAt, total: capture.exchanges.length };
}

/** A capture whose exchanges end in turn answered, refused and unanswered. */
async function withProblems(): Promise<Capture> {
  const base = await simulatedCapture();
  const [first, second, third, ...rest] = base.exchanges.filter(
    (exchange) => exchangeStatus(exchange) === "answered",
  );
  if (first === undefined || second === undefined || third === undefined) {
    throw new Error("the capture is too short");
  }
  const refused: Exchange = {
    ...second,
    outcome: { kind: "replies", replies: [{ sender: 0x7e8, messages: ["7F2111"] }] },
  };
  const silent: Exchange = { ...third, outcome: { kind: "no-response", message: "NO DATA" } };
  return { ...base, exchanges: [first, refused, silent, ...rest.slice(0, 6)] };
}

const slider = () => screen.getByRole("slider", { name: "Playback position" });

describe("the strip helpers", () => {
  it("groups any number of exchanges into a bounded strip, marking each run by its worst outcome", async () => {
    const base = await withProblems();
    const small = stripCells(buildTimeline(base));
    expect(small).toHaveLength(Math.min(base.exchanges.length, MAX_STRIP_CELLS));
    expect(small.slice(0, 3).map((cell) => cell.status)).toEqual([
      "answered",
      "negative",
      "unanswered",
    ]);

    const [first] = base.exchanges;
    if (first === undefined) throw new Error("empty");
    const long = Array.from({ length: 50_000 }, (_, index) => ({
      ...first,
      seq: index,
      at: index,
    }));
    const cells = stripCells(buildTimeline({ ...base, exchanges: long }));
    expect(cells).toHaveLength(MAX_STRIP_CELLS);
    expect(cells[0]?.from).toBe(0);
    expect(cells.at(-1)?.to).toBe(50_000);
  });

  it("finds the next refused or unanswered exchange in either direction", async () => {
    const timeline = buildTimeline(await withProblems());
    expect(nextIssue(timeline, -1, "forwards")).toBe(1);
    expect(nextIssue(timeline, 1, "forwards")).toBe(2);
    expect(nextIssue(timeline, 2, "forwards")).toBeUndefined();
    expect(nextIssue(timeline, 2, "backwards")).toBe(1);
    expect(nextIssue(timeline, 1, "backwards")).toBeUndefined();
  });

  it("writes a duration for a person", () => {
    expect(formatOffset(400)).toBe("0.4 s");
    expect(formatOffset(185_000)).toBe("3 min 5 s");
  });
});

describe("playback of a capture", () => {
  it("opens at the end showing everything, as the viewer did before playback", async () => {
    const capture = await simulatedCapture();
    const { decodeAt, total } = await show(capture);
    expect(screen.getByText(`All ${String(total)} exchanges are shown.`)).toBeVisible();
    expect(screen.getByRole("switch", { name: "Show everything" })).toBeChecked();
    expect(slider()).toHaveValue(String(total));
    expect(screen.getByRole("list", { name: "Every exchange" })).toBeVisible();
    expect(decodeAt).not.toHaveBeenCalled();
  });

  it("scrubs with the keyboard and shows the state at the cursor", async () => {
    const capture = await simulatedCapture();
    const { decodeAt, total } = await show(capture);
    slider().focus();

    await userEvent.keyboard("{Home}");
    expect(slider()).toHaveValue("0");
    expect(screen.getByRole("switch", { name: "Show everything" })).not.toBeChecked();
    expect(screen.getByText(/^Showing the 0 of/)).toBeVisible();
    expect(screen.getByRole("status", { name: "Decoding summary" })).toHaveTextContent(
      `Decoded 0 Left raw 0 of 0 exchanges`,
    );

    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(slider()).toHaveValue("2");
    await waitFor(() => {
      expect(screen.getByRole("status", { name: "Decoding summary" })).toHaveTextContent(
        /of 2 exchanges/,
      );
    });
    expect(decodeAt).toHaveBeenLastCalledWith(2);
    const list = screen.getByRole("list", { name: "Exchanges up to the cursor" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);

    await userEvent.keyboard("{ArrowLeft}");
    expect(slider()).toHaveValue("1");
    await userEvent.keyboard("{End}");
    expect(slider()).toHaveValue(String(total));
    // At the end the whole decoding is back, with no further decoding needed.
    expect(screen.getByText(`All ${String(total)} exchanges are shown.`)).toBeVisible();
  });

  it("puts the whole view back when Show everything is switched on", async () => {
    const capture = await simulatedCapture();
    const { total } = await show(capture);
    slider().focus();
    await userEvent.keyboard("{Home}");
    await userEvent.click(screen.getByRole("switch", { name: "Show everything" }));
    expect(screen.getByText(`All ${String(total)} exchanges are shown.`)).toBeVisible();
    expect(slider()).toHaveValue("0");
  });

  it("steps one exchange at a time and announces each", async () => {
    const capture = await simulatedCapture();
    await show(capture);
    slider().focus();
    await userEvent.keyboard("{Home}");
    await userEvent.click(screen.getByRole("button", { name: "Step to next exchange" }));
    expect(slider()).toHaveValue("1");
    const live = screen
      .getAllByRole("status")
      .find((node) => node.textContent.startsWith("Exchange 1 of"));
    expect(live).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Step back" }));
    expect(slider()).toHaveValue("0");
  });

  it("plays from the start with Space at the chosen speed and stops at the end", async () => {
    const capture = await simulatedCapture();
    const { total } = await show(capture);
    await userEvent.click(screen.getByRole("button", { name: "4 times speed" }));
    expect(screen.getByRole("button", { name: "4 times speed" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    slider().focus();
    await userEvent.keyboard("{Home}");
    await userEvent.keyboard(" ");
    expect(screen.getByRole("button", { name: "Pause" })).toBeVisible();
    await waitFor(() => {
      expect(Number(slider().getAttribute("value"))).toBeGreaterThan(2);
    });
    await userEvent.keyboard(" ");
    expect(screen.getByRole("button", { name: "Play" })).toBeVisible();
    const paused = slider().getAttribute("value");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(slider().getAttribute("value")).toBe(paused);

    await userEvent.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(
      () => {
        expect(slider()).toHaveValue(String(total));
      },
      { timeout: 10_000 },
    );
    expect(screen.getByRole("button", { name: "Replay" })).toBeVisible();
  }, 20_000);

  it("marks refused and unanswered exchanges in words and jumps between them", async () => {
    const capture = await withProblems();
    await show(capture);
    const key = screen.getByRole("list", { name: "Key" });
    expect(within(key).getByText(/Refused 1/)).toBeVisible();
    expect(within(key).getByText(/No answer 1/)).toBeVisible();

    fireEvent.change(slider(), { target: { value: "0" } });
    await userEvent.click(screen.getByRole("button", { name: "Next problem" }));
    expect(slider()).toHaveValue("2");
    expect(slider().getAttribute("aria-valuetext")).toContain("refused");
    await userEvent.click(screen.getByRole("button", { name: "Next problem" }));
    expect(slider().getAttribute("aria-valuetext")).toContain("no answer");
    expect(screen.getByRole("button", { name: "Next problem" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Previous problem" }));
    expect(slider().getAttribute("aria-valuetext")).toContain("refused");
  });

  it("draws only the rows in view for a long capture", async () => {
    const base = await simulatedCapture();
    const [first] = base.exchanges;
    if (first === undefined) throw new Error("empty");
    const long: Capture = {
      ...base,
      exchanges: Array.from({ length: 20_000 }, (_, index) => ({
        ...first,
        seq: index,
        at: index,
      })),
    };
    await show(long);
    const list = screen.getByRole("list", { name: "Every exchange" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.length).toBeLessThan(30);
    expect(rows[0]).toHaveAttribute("aria-setsize", "20000");
    // The tables it sits beside are bounded too.
    expect(screen.queryAllByRole("row").length).toBeLessThan(500);
    act(() => {
      list.scrollTop = 0;
      fireEvent.scroll(list);
    });
    expect(within(list).getAllByRole("listitem")[0]).toHaveAttribute("aria-posinset", "1");
  });
});
