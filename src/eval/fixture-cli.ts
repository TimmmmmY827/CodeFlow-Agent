import { Command } from "commander";

import { evaluationLanguageSchema, type EvaluationLanguage } from "./evaluation.js";
import { E1FixtureHarness } from "./fixture-harness.js";

const program = new Command();
const harness = new E1FixtureHarness();

program.name("codeflow-e1-fixtures").description("Reset and verify the trusted E1 six-task fixture suite.");

program.command("validate").action(async () => {
  const manifest = await harness.validate();
  printJson({ status: "valid", suiteId: manifest.suiteId, version: manifest.version, taskCount: manifest.tasks.length });
});

program.command("reset")
  .requiredOption("--task <id>")
  .requiredOption("--workspace <path>")
  .action(async (options: { task: string; workspace: string }) => {
    printJson(await harness.reset(options.task, options.workspace));
  });

program.command("verify")
  .requiredOption("--task <id>")
  .requiredOption("--workspace <path>")
  .action(async (options: { task: string; workspace: string }) => {
    const result = await harness.verify(options.task, options.workspace);
    printJson(result);
    if (result.status !== "passed") process.exitCode = 1;
  });

program.command("self-test")
  .option("--language <language...>", "Only self-test selected languages")
  .action(async (options: { language?: string[] }) => {
    const languages = options.language === undefined
      ? evaluationLanguageSchema.options
      : evaluationLanguageSchema.array().min(1).parse(options.language) as EvaluationLanguage[];
    const report = await harness.selfTest(languages);
    printJson(report);
    if (!report.passed) process.exitCode = 1;
  });

const argv = process.argv[2] === "--"
  ? [...process.argv.slice(0, 2), ...process.argv.slice(3)]
  : process.argv;
await program.parseAsync(argv);

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
