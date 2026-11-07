#!/usr/bin/env node
// The bench harvester's command line. See bench/README.md and `bench/lib/harvest.mjs`.
import { harvestMain } from "./lib/harvest.mjs";

process.exitCode = await harvestMain(process.argv.slice(2));
