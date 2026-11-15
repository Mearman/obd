/**
 * Data files bundled with the package, as modules that work in Node and in the browser.
 */

import { parseGenericTitles } from "../core/codenames.js";
import obdexGeneric from "./obdex-generic.json" with { type: "json" };

/** The bundled generic OBD-II code titles (OBDex, CC0), keyed by SAE code such as P0420. */
export function loadGenericTitles(): ReadonlyMap<string, string> {
  return parseGenericTitles(obdexGeneric);
}
