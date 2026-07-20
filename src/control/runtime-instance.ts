export function controlRuntimeInstance(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.MAGI_DAEMON_INSTANCE?.trim();
  if (!value) return "default";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(value)) {
    throw new Error(
      "MAGI_DAEMON_INSTANCE must contain only letters, numbers, underscores, or hyphens"
    );
  }
  return value.toLowerCase();
}

export function jobRuntimeInstance(metadata: Record<string, unknown> | undefined): string {
  const value = metadata?.daemonInstance;
  return typeof value === "string" && value.trim() ? value : "default";
}
