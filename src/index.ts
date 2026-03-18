#!/usr/bin/env node

// CLI 入口文件

import { config as loadEnv } from "dotenv";

import { buildProgram, normalizeArgv } from "./cli.js";

loadEnv();

const program = buildProgram();
await program.parseAsync(normalizeArgv(process.argv));
