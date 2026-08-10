import { Command } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { createAnthropicClient } from "../providers/anthropic.js";

const program = new Command();

program
  .name("run-agent")
  .description("Run Agent — a transparent, multi-provider coding agent for your terminal.")
  .version(pkg.version, "-v, --version")
  .argument("[prompt]", "the prompt to run")
  .option("-m, --model <model>", "model to use")
  .action(async (prompt: string | undefined) => {
    if (!prompt) {
      program.help();
      return;
    }
    const client = createAnthropicClient();
    const reply = await client.chat([{ role: "user", content: prompt }]);
    process.stdout.write(reply + "\n");
  });

program.parse();
