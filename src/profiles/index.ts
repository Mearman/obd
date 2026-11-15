/**
 * The vehicle profiles shipped with the package, as a registry that works in Node and in the browser.
 *
 * The JSON files are imported rather than read, so a bundler includes them and no file access is needed. A profile from anywhere else (a file the user picks, a document in storage) goes through `parseProfile` in core.
 */

import { pythonRepr } from "../core/format.js";
import { ProfileError, parseProfile, type Profile } from "../core/profile.js";
import bmwFFem from "./bmw-f-fem.json" with { type: "json" };
import bmwG29 from "./bmw-g29.json" with { type: "json" };
import bmwI3 from "./bmw-i3.json" with { type: "json" };
import fordFocus from "./ford-focus.json" with { type: "json" };
import fordRanger from "./ford-ranger.json" with { type: "json" };
import hondaAcura29bit from "./honda-acura-29bit.json" with { type: "json" };
import hyundaiKiaGenesis from "./hyundai-kia-genesis.json" with { type: "json" };
import mazdaSkyactiv from "./mazda-skyactiv.json" with { type: "json" };
import mercedesW203W209 from "./mercedes-w203-w209.json" with { type: "json" };
import mercedesW211 from "./mercedes-w211.json" with { type: "json" };
import mitsubishiPhevImiev from "./mitsubishi-phev-imiev.json" with { type: "json" };
import nissanInfinitiCan from "./nissan-infiniti-can.json" with { type: "json" };
import nissanLeaf from "./nissan-leaf.json" with { type: "json" };
import psaKwp2000 from "./psa-kwp2000.json" with { type: "json" };
import psaUds from "./psa-uds.json" with { type: "json" };
import renaultDaciaCore from "./renault-dacia-core.json" with { type: "json" };
import renaultTwingoSmart453 from "./renault-twingo-smart-453.json" with { type: "json" };
import renaultTwizy from "./renault-twizy.json" with { type: "json" };
import renaultZoePh1 from "./renault-zoe-ph1.json" with { type: "json" };
import renaultZoePh2 from "./renault-zoe-ph2.json" with { type: "json" };
import toyotaTnga from "./toyota-tnga.json" with { type: "json" };
import vagMqb from "./vag-mqb.json" with { type: "json" };
import vwUp from "./vw-up.json" with { type: "json" };

const SHIPPED: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ["bmw-f-fem", bmwFFem],
  ["bmw-g29", bmwG29],
  ["bmw-i3", bmwI3],
  ["ford-focus", fordFocus],
  ["ford-ranger", fordRanger],
  ["honda-acura-29bit", hondaAcura29bit],
  ["hyundai-kia-genesis", hyundaiKiaGenesis],
  ["mazda-skyactiv", mazdaSkyactiv],
  ["mercedes-w203-w209", mercedesW203W209],
  ["mercedes-w211", mercedesW211],
  ["mitsubishi-phev-imiev", mitsubishiPhevImiev],
  ["nissan-infiniti-can", nissanInfinitiCan],
  ["nissan-leaf", nissanLeaf],
  ["psa-kwp2000", psaKwp2000],
  ["psa-uds", psaUds],
  ["renault-dacia-core", renaultDaciaCore],
  ["renault-twingo-smart-453", renaultTwingoSmart453],
  ["renault-twizy", renaultTwizy],
  ["renault-zoe-ph1", renaultZoePh1],
  ["renault-zoe-ph2", renaultZoePh2],
  ["toyota-tnga", toyotaTnga],
  ["vag-mqb", vagMqb],
  ["vw-up", vwUp],
]);

/** Names of the profiles shipped with the package, sorted. */
export function builtinProfiles(): string[] {
  return [...SHIPPED.keys()].sort();
}

/**
 * The parsed JSON of a shipped profile, unvalidated, as `checkProfile` and `parseProfile` take it.
 *
 * Throws {@link ProfileError} listing the shipped names when there is no such profile.
 */
export function builtinProfileData(name: string): unknown {
  if (!SHIPPED.has(name)) {
    throw new ProfileError([
      `no profile named ${pythonRepr(name)}; shipped profiles: ${builtinProfiles().join(", ")}`,
    ]);
  }
  return SHIPPED.get(name);
}

/** Loads a shipped profile by name. Throws {@link ProfileError} when there is no such profile or it is invalid. */
export function loadBuiltinProfile(name: string): Profile {
  return parseProfile(builtinProfileData(name), name);
}
