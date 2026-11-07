#!/usr/bin/env node
// The judges' calibration run on the calibration sets. See bench/README.md and `bench/lib/judge-calibration.mjs`.
import { judgeCalibrationMain } from "./lib/judge-calibration.mjs";

process.exitCode = await judgeCalibrationMain(process.argv.slice(2));
