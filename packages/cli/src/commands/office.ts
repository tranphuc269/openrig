import { Command } from "commander";

/**
 * `rig office` — build and read Word (.docx) and Excel (.xlsx) documents.
 * Factory Studio agents use it for documents that must follow a form; the
 * work itself lives in the daemon package (office-cli), run in this process.
 */
export function officeCommand(): Command {
  return new Command("office")
    .description("Build Word/Excel documents from a form, inspect forms, read .docx/.xlsx as Markdown")
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument("[args...]", "inspect | docx | xlsx | read, then their options (rig office --help)")
    .action(async (_args: string[], _opts: unknown, command: Command) => {
      const { main } = await import("@openrig/daemon/office");
      await main(command.args);
    });
}
