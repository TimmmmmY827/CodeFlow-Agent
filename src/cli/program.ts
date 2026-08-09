import { resolve } from "node:path";

import { Command } from "commander";

import { createApplication } from "../app/application.js";

const VERSION = "0.1.0";

export function createProgram(): Command {
  const program = new Command();
  program
    .name("codeflow")
    .description("透明、可追溯的本地 Coding Agent")
    .version(VERSION)
    .showHelpAfterError();

  program
    .command("run")
    .description("在指定工作区启动新的 Coding 任务")
    .argument("[workspace]", "目标工作区", ".")
    .option("-p, --prompt <goal>", "任务目标")
    .action(async (workspace: string, options: { prompt?: string }) => {
      const application = createApplication();
      const target = resolve(workspace);

      if (!options.prompt) {
        printScaffoldNotice("run", `工作区：${target}`);
        return;
      }

      const session = await application.eventLoop.createSession({
        goal: options.prompt,
        workspace: target,
      });
      console.log(`已创建本地内存 Session：${session.sessionId}`);
      console.log("D2–D4 将接通模型、工具与持久化执行循环；本次没有修改工作区。");
    });

  program
    .command("resume")
    .description("恢复已有 Session")
    .argument("<session>", "Session ID")
    .action((session: string) => printScaffoldNotice("resume", `Session：${session}`));

  program
    .command("sessions")
    .description("列出本地 Session")
    .action(() => printScaffoldNotice("sessions", "SQLite Session 仓储将在 D7 接通。"));

  program
    .command("trace")
    .description("查看 Session trace")
    .argument("<session>", "Session ID")
    .action((session: string) => printScaffoldNotice("trace", `Session：${session}`));

  program
    .command("config")
    .description("检查本地配置，不显示凭证内容")
    .action(() => {
      console.log(`DeepSeek API Key：${isConfigured("DEEPSEEK_API_KEY") ? "已配置" : "未配置"}`);
      console.log(`Exa API Key：${isConfigured("EXA_API_KEY") ? "已配置" : "未配置"}`);
      console.log(`默认模型：${process.env.CODEFLOW_MODEL ?? "deepseek-v4-flash"}`);
      console.log(`数据目录：${process.env.CODEFLOW_DATA_DIR ?? ".codeflow"}`);
    });

  program
    .command("eval")
    .description("运行六任务 MVP 评估")
    .action(() => printScaffoldNotice("eval", "评估 fixtures 和隐藏验证器将在 D8 接通。"));

  return program;
}

function isConfigured(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function printScaffoldNotice(command: string, detail: string): void {
  console.log(`codeflow ${command}：当前仓库处于 D1 工程骨架阶段。`);
  console.log(detail);
  console.log("命令边界已建立，但尚未执行模型调用、工具调用或外部写入。");
}
