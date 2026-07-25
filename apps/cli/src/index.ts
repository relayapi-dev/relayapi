#!/usr/bin/env node
import { Command } from "commander";
import { registerAccountCommands } from "./commands/accounts.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerMediaCommands } from "./commands/media.js";
import { registerPostCommands } from "./commands/posts.js";
import { VERSION } from "./version.js";

const program = new Command()
	.name("relay")
	.description("RelayAPI CLI — Unified social media posting")
	.version(VERSION)
	.option("--table", "Output as formatted table")
	.action(() => {
		program.help();
	});

registerAuthCommands(program);
registerAccountCommands(program);
registerMediaCommands(program);
registerPostCommands(program);

program.parse();
