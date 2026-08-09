#!/usr/bin/env bun
import { main } from "../roles/cli.ts";

process.exit(main(process.argv.slice(2)));
