#!/usr/bin/env node
// The bench's pool gate: calibration, stage 1 and stage 2 (R) from the owners' kept tasks. See bench/README.md,
// docs/plans/router-bench.md and `bench/lib/pool.mjs`.
import { poolMain } from "./lib/pool.mjs";

process.exitCode = poolMain(process.argv.slice(2));
