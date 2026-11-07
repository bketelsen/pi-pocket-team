#!/usr/bin/env node
// The bench scorer's command line (S0 to S3 of 1 result file). See bench/README.md and `bench/lib/score.mjs`.
import { scoreMain } from "./lib/score.mjs";

process.exitCode = await scoreMain(process.argv.slice(2));
