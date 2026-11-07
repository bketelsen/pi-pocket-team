#!/usr/bin/env node
// The judge calibration sets' builder. See bench/README.md and `bench/lib/calibration.mjs`.
import { calibrationMain } from "./lib/calibration.mjs";

process.exitCode = await calibrationMain(process.argv.slice(2));
