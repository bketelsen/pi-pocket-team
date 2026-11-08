#!/usr/bin/env node
// The judge calibration's instrument: the plan, the attempts and their checks, and the blind label packs. See
// bench/README.md ("Calibration") and `bench/lib/calibration.mjs`.
import { calibrationMain } from "./lib/calibration-cli.mjs";

process.exitCode = await calibrationMain(process.argv.slice(2));
