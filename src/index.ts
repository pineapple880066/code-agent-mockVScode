#!/usr/bin/env node

import { config as loadEnv } from "dotenv";

import { buildProgram, normalizeArgv } from "./cli.js";

loadEnv();

const program = buildProgram();
await program.parseAsync(normalizeArgv(process.argv));
