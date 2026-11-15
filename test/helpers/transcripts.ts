/** Replay a recorded adapter transcript as the replies of a car, for tests. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  fromHex,
  isotpReassemble,
  toUpperHex,
  type IdentifiedFrame,
} from "../../src/core/index.js";
import type { Responder } from "./fake-elm.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** One request payload (upper-case hex) mapped to the (sender, message) pairs the car answered with. */
export type Replies = Map<string, [number, Uint8Array][]>;

/**
 * Reads transcripts written by `Transcript` and collects each diagnostic request's replies.
 *
 * Lines sent to the adapter start with `>` and lines received with `<`. Adapter set-up commands and
 * requests that drew no data are skipped.
 */
export function loadReplies(...names: string[]): Replies {
  const replies: Replies = new Map();
  for (const name of names) {
    let command: string | undefined;
    let frames: IdentifiedFrame[] = [];

    const finish = (): void => {
      if (
        command !== undefined &&
        !command.startsWith("AT") &&
        !command.startsWith("ST") &&
        frames.length > 0
      ) {
        replies.set(
          command,
          Array.from(isotpReassemble(frames), ([sender, found]) =>
            found.map((message): [number, Uint8Array] => [sender, message]),
          ).flat(),
        );
      }
    };

    for (const line of readFileSync(`${FIXTURES}${name}`, "utf8").split("\n")) {
      if (line === "") continue;
      const first = line.indexOf(" ");
      const second = line.indexOf(" ", first + 1);
      const direction = line.slice(first + 1, second);
      const text = line.slice(second + 1);
      if (direction === ">") {
        finish();
        command = text;
        frames = [];
      } else if (
        text.length > 3 &&
        /^[0-9A-Za-z]{3}/.test(text) &&
        text !== "NO DATA" &&
        text !== "ELM327 v1.5"
      ) {
        try {
          if (!/^[0-9A-Fa-f]{3}/.test(text)) continue;
          frames.push([Number.parseInt(text.slice(0, 3), 16), fromHex(text.slice(3))]);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
    }
    finish();
  }
  return replies;
}

/** A functional-address responder that answers from recorded replies and is silent otherwise. */
export function responder(replies: Replies): Responder {
  return (request) => replies.get(toUpperHex(request)) ?? [];
}
