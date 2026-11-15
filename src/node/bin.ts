#!/usr/bin/env node
/** The `obd-read` executable: registers the Node transports, runs the command line and exits with its status. */

import "./index.js";
import { main } from "./cli.js";

process.exitCode = await main(process.argv.slice(2));
