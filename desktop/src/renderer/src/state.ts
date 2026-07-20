import type {
  MagiEvent,
  PermissionMode,
  ProviderCatalog,
  SessionSummary
} from "../../shared/contracts";

export interface ProjectGroup {
  path: string;
  name: string;
  sessions: SessionSummary[];
}

export interface ModelOption {
  value: string;
  label: string;
}

export function buildModelOptions(
  catalog: ProviderCatalog | undefined,
  currentModel?: string
): ModelOption[] {
  const options: ModelOption[] = [];
  const seen = new Set<string>();
  const add = (value: string, label: string): void => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    options.push({ value, label });
  };

  if (catalog?.modelCapabilities && Object.keys(catalog.modelCapabilities).length > 0) {
    add("auto", "auto · smart routing");
  }
  for (const [alias, target] of Object.entries(catalog?.aliases ?? {})) {
    add(alias, `${alias} · ${target}`);
  }
  for (const provider of catalog?.providers ?? []) {
    for (const model of provider.models ?? []) {
      add(`${provider.name}:${model}`, `${model} · ${provider.name}`);
    }
  }
  if (currentModel) add(currentModel, currentModel);
  return options;
}

export function projectName(projectPath: string): string {
  const normalized = projectPath.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || normalized;
}

export function groupSessions(
  sessions: SessionSummary[],
  recentProjects: string[] = []
): ProjectGroup[] {
  const paths = [
    ...recentProjects,
    ...sessions
      .map((session) => session.cwd)
      .filter((value, index, all) => all.indexOf(value) === index)
  ].filter((value, index, all) => all.indexOf(value) === index);
  return paths.map((projectPath) => ({
    path: projectPath,
    name: projectName(projectPath),
    sessions: sessions
      .filter((session) => session.cwd === projectPath)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }));
}

export function toggleProjectPath(collapsedProjects: string[], projectPath: string): string[] {
  return collapsedProjects.includes(projectPath)
    ? collapsedProjects.filter((item) => item !== projectPath)
    : [...collapsedProjects, projectPath];
}

export function permissionModeLabel(mode: PermissionMode): string {
  switch (mode) {
    case "default":
      return "变更前询问";
    case "acceptEdits":
      return "替我审批";
    case "plan":
      return "只读计划";
    case "dontAsk":
      return "自动拒绝";
    case "bypassPermissions":
      return "完全访问";
  }
}

export function mergeEvents(current: MagiEvent[], incoming: MagiEvent | MagiEvent[]): MagiEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of Array.isArray(incoming) ? incoming : [incoming]) byId.set(event.id, event);
  return [...byId.values()].sort((left, right) => left.id - right.id);
}

export function eventDelta(event: MagiEvent): string {
  if (event.action !== "agent.text.delta") return "";
  return typeof event.metadata.text === "string"
    ? event.metadata.text
    : typeof event.metadata.preview === "string"
      ? event.metadata.preview
      : "";
}

export function streamedTextForJob(events: MagiEvent[], jobId: string): string {
  return [...events]
    .sort((left, right) => left.id - right.id)
    .filter((event) => event.jobId === jobId)
    .map(eventDelta)
    .join("");
}

export function isTerminalEvent(event: MagiEvent): boolean {
  return ["agent.query.completed", "agent.query.failed", "agent.query.cancelled"].includes(
    event.action
  );
}

export function isChangeEvent(event: MagiEvent): boolean {
  const target = event.target ?? "";
  return (
    event.category === "git" ||
    /^(Write|Edit|Patch|File|MultiEdit|Notebook)/i.test(target) ||
    /\b(file|patch|diff|write|edit)\b/i.test(event.message)
  );
}

export function compactPath(value: string, max = 38): string {
  if (value.length <= max) return value;
  const parts = value.split(/[\\/]/).filter(Boolean);
  if (parts.length < 3) return `…${value.slice(-(max - 1))}`;
  const compact = `…/${parts.slice(-2).join("/")}`;
  return compact.length <= max ? compact : `…${compact.slice(-(max - 1))}`;
}
