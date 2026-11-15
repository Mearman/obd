/** A caller's option is outside what the operation accepts, such as a count below one. */
export class OptionError extends Error {
  override name = "OptionError";
}
