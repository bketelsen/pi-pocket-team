#!/usr/bin/env node
// The bench runner's command line. See bench/README.md and `bench/lib/runner.mjs`.
import { main } from "./lib/runner.mjs";

process.exitCode = await main();
