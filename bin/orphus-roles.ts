#!/usr/bin/env bun
import { main } from "../src/roles/cli.ts";

process.exit(main(process.argv.slice(2)));
