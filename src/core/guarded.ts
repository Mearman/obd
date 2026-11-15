/**
 * Two-step confirmation of the operations that change the car: clear, write and actuate.
 *
 * The existing commands run one flow: read, save the snapshot, show what would be sent, ask for a typed `yes`, send through the guard. {@link PendingConfirmations} runs that same flow with the question answered by a second call. The first call runs until the command asks, then returns what it printed and the id of the pending operation; the command is parked there, holding the adapter. The second call, carrying that id, answers it. Nothing is sent before the answer, the guard's single-use tokens exist only inside the command and are never visible to a caller, and an id passes once.
 *
 * At most one operation is pending, so two callers cannot park the adapter against each other, and a pending one expires after a fixed time so a closed page cannot hold the adapter for ever. This module is platform-free.
 */

import { after } from "./time.js";
import type { LineSink } from "./unit-access.js";

/** A second operation was requested while one waits for its answer. */
export class ConfirmationPending extends Error {
  override name = "ConfirmationPending";
}

/** The confirmation id is not pending: it was answered, it expired, or it never existed. */
export class UnknownConfirmation extends Error {
  override name = "UnknownConfirmation";
}

/** The operations that change the car. */
export type GuardedKind = "clear" | "write" | "actuate";

/** What a guarded command is waiting to have confirmed. */
export interface GuardedRequest {
  /** The id the second call carries. */
  readonly confirmation: string;
  /** The question the command asked. */
  readonly prompt: string;
  /** What the command printed before asking: what would be sent, and the snapshot. */
  readonly lines: string[];
  /** When the confirmation expires, as milliseconds since the Unix epoch. */
  readonly expiresAt: number;
}

/** How a guarded command ended. */
export interface GuardedOutcome {
  /** Whether the answer was yes. */
  readonly confirmed: boolean;
  /** The command's exit status: 0 when it did what it was asked, 1 when it was declined or the result did not match. */
  readonly exitStatus: number;
  /** Everything the command printed, from the start. */
  readonly lines: string[];
}

/** What a guarded command is given to talk through: where to print, and the question to ask. */
export interface GuardedIo {
  readonly out: LineSink;
  /** Asks the question and resolves with `"yes"` or `"no"`. */
  readonly ask: (prompt: string) => Promise<string>;
}

interface Pending {
  readonly id: string;
  readonly kind: GuardedKind;
  readonly decision: (confirmed: boolean) => void;
  readonly finished: Promise<number>;
  readonly lines: string[];
  readonly cancelExpiry: () => void;
}

/** The pending guarded operation, if any. */
export class PendingConfirmations {
  private current: Pending | undefined;
  private issued = 0;

  /**
   * @param ttlMs How long a pending operation waits for its answer, in milliseconds.
   * @param now The clock for `expiresAt`.
   */
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  /** Whether an operation is waiting for its answer. */
  get isPending(): boolean {
    return this.current !== undefined;
  }

  /**
   * Starts `command` and returns once it asks its question.
   *
   * @throws ConfirmationPending when another operation waits for its answer.
   * @throws whatever `command` throws before it asks, such as a guard refusal; nothing is left pending.
   * @throws Error when `command` ends without asking, which would mean a guarded operation that needs no confirmation.
   */
  async begin(
    kind: GuardedKind,
    command: (io: GuardedIo) => Promise<number>,
  ): Promise<GuardedRequest> {
    if (this.current !== undefined) {
      throw new ConfirmationPending(
        "an operation is waiting for its confirmation; confirm or cancel it first",
      );
    }
    this.issued += 1;
    const id = `confirm-${String(this.issued)}-${Math.random().toString(36).slice(2, 10)}`;
    const lines: string[] = [];
    let decide: (confirmed: boolean) => void = () => undefined;
    const decision = new Promise<boolean>((resolve) => {
      decide = resolve;
    });
    let asked: (prompt: string) => void = () => undefined;
    const question = new Promise<string>((resolve) => {
      asked = resolve;
    });
    const finished = command({
      out: (line) => lines.push(line),
      ask: async (prompt) => {
        asked(prompt);
        return (await decision) ? "yes" : "no";
      },
    });
    // The outcome is read by confirm or cancel; a failure before then is reported through begin.
    finished.catch(() => undefined);
    const prompt = await Promise.race([
      question,
      finished.then(() => {
        throw new Error("a guarded operation ended without asking for confirmation");
      }),
    ]);
    const expiresAt = this.now() + this.ttlMs;
    const pending: Pending = {
      id,
      kind,
      decision: decide,
      finished,
      lines,
      cancelExpiry: after(this.ttlMs, () => {
        void this.settle(id, undefined, false).catch(() => undefined);
      }),
    };
    this.current = pending;
    return { confirmation: id, prompt, lines: [...lines], expiresAt };
  }

  /**
   * Answers yes: the command sends what it showed, through the guard.
   *
   * @throws UnknownConfirmation unless `id` is pending and was begun as `kind`; a mismatch leaves it pending.
   * @throws whatever the command throws once confirmed, such as a guard refusal because the snapshot has gone.
   */
  confirm(id: string, kind: GuardedKind): Promise<GuardedOutcome> {
    return this.settle(id, kind, true);
  }

  /**
   * Answers no: the command sends nothing and the snapshot stays.
   *
   * @throws UnknownConfirmation unless `id` is pending.
   */
  cancel(id: string): Promise<GuardedOutcome> {
    return this.settle(id, undefined, false);
  }

  private async settle(
    id: string,
    kind: GuardedKind | undefined,
    confirmed: boolean,
  ): Promise<GuardedOutcome> {
    const pending = this.current;
    if (pending?.id !== id || (kind !== undefined && pending.kind !== kind)) {
      throw new UnknownConfirmation(
        `no ${kind ?? "guarded"} operation is waiting under confirmation ${id}`,
      );
    }
    this.current = undefined;
    pending.cancelExpiry();
    pending.decision(confirmed);
    const exitStatus = await pending.finished;
    return { confirmed, exitStatus, lines: [...pending.lines] };
  }
}
