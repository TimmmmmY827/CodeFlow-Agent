#!/usr/bin/env node

import { createProgram } from "./program.js";

const argv = process.argv[2] === "--"
  ? [...process.argv.slice(0, 2), ...process.argv.slice(3)]
  : process.argv;

await createProgram().parseAsync(argv);
