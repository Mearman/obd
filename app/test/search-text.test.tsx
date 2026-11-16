import { act, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect, useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { useSearchText } from "../src/library/useSearchText";

/** One committed frame: the search the address held and the text the field showed in the same commit. */
interface Frame {
  readonly search: string;
  readonly field: string;
}

/**
 * A history of search values standing in for the address, whose writes reach the field only when the test delivers them, so a test chooses the order in which the field's own writes and Back arrive.
 */
class Address {
  entries: string[] = [""];
  index = 0;
  delivered = "";
  private listener: ((search: string) => void) | undefined;

  /** Where the address hands its values: the rendered field's state setter. */
  listen(listener: (search: string) => void): void {
    this.listener = listener;
  }

  /** Hands the field `search`, as the router does once it has read an address. */
  deliver(search: string): void {
    if (this.listener === undefined) throw new Error("the field is not rendered");
    this.listener(search);
  }

  write(text: string, replace: boolean): void {
    if (replace) this.entries[this.index] = text;
    else {
      this.entries = [...this.entries.slice(0, this.index + 1), text];
      this.index += 1;
    }
  }

  /** Hands the field the value of the current entry, as the router does once it has read the address. */
  arrive(): void {
    const current = this.entries[this.index];
    if (current === undefined) throw new Error("no entry at the index");
    this.delivered = current;
    this.deliver(current);
  }

  back(): void {
    this.index -= 1;
    this.arrive();
  }

  forward(): void {
    this.index += 1;
    this.arrive();
  }
}

function Field({ address, frames }: { readonly address: Address; readonly frames: Frame[] }) {
  const [search, setSearch] = useState(address.delivered);
  useLayoutEffect(() => {
    address.listen(setSearch);
  }, [address]);
  const field = useSearchText(search, (text, replace) => {
    address.write(text, replace);
  });
  const input = useRef<HTMLInputElement>(null);
  // A layout effect runs after the commit's DOM changes and before any passive effect, so it sees what a person would see in that frame.
  useLayoutEffect(() => {
    if (input.current === null) throw new Error("the input is not mounted");
    frames.push({ search, field: input.current.value });
  });
  return (
    <input
      ref={input}
      aria-label="Search"
      value={field.text}
      onChange={(event) => {
        field.change(event.currentTarget.value);
      }}
      onBlur={field.end}
    />
  );
}

function setup(): {
  address: Address;
  frames: Frame[];
  type: (text: string) => void;
  end: () => void;
} {
  const address = new Address();
  const frames: Frame[] = [];
  render(<Field address={address} frames={frames} />);
  const input = screen.getByRole("textbox", { name: "Search" });
  return {
    address,
    frames,
    type: (text) => {
      fireEvent.change(input, { target: { value: text } });
    },
    end: () => {
      fireEvent.focusOut(input);
    },
  };
}

function lastFrame(frames: readonly Frame[]): Frame {
  const frame = frames.at(-1);
  if (frame === undefined) throw new Error("no frame committed");
  return frame;
}

describe("useSearchText", () => {
  it("shows the search Back reaches in the same commit that brings it", () => {
    const { address, frames, type, end } = setup();
    for (const text of ["o", "ow", "own"]) {
      type(text);
      act(() => {
        address.arrive();
      });
    }
    end();
    type("ownx");
    act(() => {
      address.arrive();
    });
    const before = frames.length;
    act(() => {
      address.back();
    });
    const arrived = frames.slice(before).find((frame) => frame.search === "own");
    expect(arrived).toEqual({ search: "own", field: "own" });
    act(() => {
      address.back();
    });
    expect(lastFrame(frames)).toEqual({ search: "", field: "" });
    act(() => {
      address.forward();
    });
    expect(lastFrame(frames)).toEqual({ search: "own", field: "own" });
  });

  it("adds one history entry for each edit, ended by the field losing focus", () => {
    const { address, type, end } = setup();
    for (const text of ["a", "ab", "abc"]) {
      type(text);
      act(() => {
        address.arrive();
      });
    }
    expect(address.entries).toEqual(["", "abc"]);
    end();
    type("abcd");
    expect(address.entries).toEqual(["", "abc", "abcd"]);
  });

  it("keeps the typed text while the address returns the field's own earlier writes", () => {
    const { address, frames, type, end } = setup();
    type("a");
    type("ab");
    type("abc");
    // The address reads its entry late, after the person has typed on.
    act(() => {
      address.deliver("a");
    });
    expect(lastFrame(frames)).toEqual({ search: "a", field: "abc" });
    end();
    act(() => {
      address.deliver("ab");
    });
    expect(lastFrame(frames)).toEqual({ search: "ab", field: "abc" });
    act(() => {
      address.arrive();
    });
    expect(lastFrame(frames)).toEqual({ search: "abc", field: "abc" });
  });

  it("follows Back during an edit to a value the edit wrote on the way, and starts a new edit after it", () => {
    const { address, frames, type, end } = setup();
    for (const text of ["a", "ab"]) {
      type(text);
      act(() => {
        address.arrive();
      });
    }
    end();
    // A second edit passes through "ab" again, and the address has caught up with its last write.
    for (const text of ["abc", "ab", "abd"]) {
      type(text);
      act(() => {
        address.arrive();
      });
    }
    expect(address.entries).toEqual(["", "ab", "abd"]);
    act(() => {
      address.back();
    });
    expect(lastFrame(frames)).toEqual({ search: "ab", field: "ab" });
    type("abe");
    expect(address.entries).toEqual(["", "ab", "abe"]);
  });
});
