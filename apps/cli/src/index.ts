#!/usr/bin/env bun
import { Command } from "commander";
import { registerAuthCommands } from "./commands/auth.js";
import { registerAccountCommands } from "./commands/accounts.js";
import { registerMediaCommands } from "./commands/media.js";
import { registerPostCommands } from "./commands/posts.js";

const program = new Command()
	.name("relay")
	.description("RelayAPI CLI — Unified social media posting")
	.version("0.0.1")
	.option("--table", "Output as formatted table")
	.action(() => {
		program.help();
	});

registerAuthCommands(program);
registerAccountCommands(program);
registerMediaCommands(program);
registerPostCommands(program);

program.parse();
