/** The one Bluetooth LE radio of the process, shared by the `ble` transport and the adapter discovery commands so that closing it at the end of a command releases everything noble opened. */

import type { BleCentral } from "./ble.js";
import { createNobleCentral } from "./noble.js";

/** The process's radio. Creating it loads nothing native; the first scan does. */
export const processCentral: BleCentral = createNobleCentral();
