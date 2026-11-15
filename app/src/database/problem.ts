import type { DatabaseProblem } from "./DatabaseProvider";

/**
 * Why the database cannot be used, as a clause that follows "because": the problem the provider reports, with the failure's own message for a failure it has no wording for.
 */
export function unavailableBecause(problem: DatabaseProblem, message: string): string {
  switch (problem) {
    case "in-use":
      return "obd-read is open in another tab or window that cannot share its stored data with this one";
    case "unsupported":
      return "this browser cannot store data on this device";
    case "failed":
      return `the stored data could not be opened (${message})`;
  }
}
