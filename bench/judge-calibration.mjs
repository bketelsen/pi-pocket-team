#!/usr/bin/env node
// The judges' calibration run on the owners' label packs. See bench/README.md ("Calibration") and
// `bench/lib/judge-calibration.mjs`.
import { judgeCalibrationMain } from "./lib/judge-calibration.mjs";

process.exitCode = await judgeCalibrationMain(process.argv.slice(2));
