export type InstructionSource =
  | "system"
  | "user"
  | "agents"
  | "project"
  | "repository"
  | "external";

export interface ContextSection {
  readonly source: InstructionSource;
  readonly title: string;
  readonly content: string;
}

const SOURCE_PRIORITY: Readonly<Record<InstructionSource, number>> = {
  system: 0,
  user: 1,
  agents: 2,
  project: 3,
  repository: 4,
  external: 5,
};

export class ContextAssembler {
  assemble(sections: readonly ContextSection[]): string {
    return [...sections]
      .sort((left, right) => SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source])
      .map(
        (section) =>
          `<context source="${section.source}" title="${escapeAttribute(section.title)}">\n${section.content}\n</context>`,
      )
      .join("\n\n");
  }
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
