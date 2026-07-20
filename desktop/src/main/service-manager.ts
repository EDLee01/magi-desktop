import { app } from "electron";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import { HeadlessClientError, MagiHeadlessClient } from "../../../dist/control/client.js";
import { encodePromptWithImages } from "../../../dist/providers/ir.js";
import type {
  ActiveInteraction,
  ConfigureProviderInput,
  ConfigureProviderResult,
  DesktopBootstrap,
  JobStartResult,
  MagiEvent,
  ProviderCatalog,
  ServiceStatus,
  SessionRecord,
  SessionRuntime,
  SessionSummary,
  StartJobInput,
  StreamEnvelope,
  UpdateSettingsInput,
  UserQuestionAnswer
} from "../shared/contracts.js";
import { DesktopSettingsStore } from "./settings-store.js";

const execFileAsync = promisify(execFile);
const EMPTY_PROVIDERS: ProviderCatalog = { providers: [], aliases: { main: "main" } };
const DESKTOP_PAIRING_TTL_MS = 365 * 24 * 60 * 60_000;
const DESKTOP_DAEMON_INSTANCE = "desktop";

type ClientFactory = (baseUrl: string) => MagiHeadlessClient;

interface ExistingDaemonInfo {
  baseUrl: string;
  port: number;
  allowAnyCwd?: boolean;
}

export class MagiServiceManager extends EventEmitter {
  private client?: MagiHeadlessClient;
  private connectPromise?: Promise<void>;
  private reauthPromise?: Promise<MagiHeadlessClient>;
  private serviceStatus: ServiceStatus = { connected: false, phase: "offline" };
  private readonly subscriptions = new Map<number, AbortController>();

  constructor(
    private readonly settings: DesktopSettingsStore,
    private readonly createClient: ClientFactory = (baseUrl) => new MagiHeadlessClient({ baseUrl })
  ) {
    super();
  }

  async bootstrap(): Promise<DesktopBootstrap> {
    await this.ensureConnected();
    let providers = EMPTY_PROVIDERS;
    if (this.client && this.serviceStatus.connected) {
      try {
        providers = await this.withAuthorizedClient(
          async (client) => (await client.listProviders()) as ProviderCatalog
        );
        if (Object.keys(providers.aliases).length === 0) {
          providers.aliases = { main: providers.providers[0]?.defaultModel ?? "main" };
        }
      } catch {}
    }
    return {
      settings: await this.settings.get(),
      status: this.serviceStatus,
      providers
    };
  }

  async reconnect(): Promise<void> {
    this.connectPromise = undefined;
    await this.ensureConnected();
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.withAuthorizedClient(async (client) =>
      ((await client.listSessions(200)).sessions as SessionSummary[]).filter(
        (session) => !isControlSession(session)
      )
    );
  }

  async getSession(id: string): Promise<SessionRecord> {
    return this.withAuthorizedClient(
      async (client) => (await client.getSession(id)).session as SessionRecord
    );
  }

  async getSessionRuntime(sessionId: string): Promise<SessionRuntime> {
    return this.withAuthorizedClient(async (client) => {
      const jobs = (await client.listJobs(200)).jobs as Array<{
        id: string;
        sessionId: string;
        kind: string;
        status: string;
        createdAt?: string;
        updatedAt?: string;
        metadata?: Record<string, unknown>;
      }>;
      const activeJob = jobs
        .filter((job) => job.sessionId === sessionId && job.status === "running")
        .sort((left, right) =>
          (right.updatedAt ?? right.createdAt ?? "").localeCompare(
            left.updatedAt ?? left.createdAt ?? ""
          )
        )[0];
      const interactions = activeJob
        ? (
            (await client.getJobInteractions(activeJob.id)).interactions as ActiveInteraction[]
          ).filter((interaction) => interaction.status === "pending")
        : [];
      return { activeJob, interactions };
    });
  }

  async updateSettings(input: UpdateSettingsInput) {
    if (input.selectedProject !== undefined) {
      const requestedProject = path.resolve(input.selectedProject);
      const current = await this.settings.get();
      const knownSessions = await this.listSessions();
      const allowed = [
        current.selectedProject,
        ...current.recentProjects,
        this.serviceStatus.workspace,
        ...knownSessions.map((session) => session.cwd)
      ]
        .filter((project): project is string => Boolean(project))
        .map((project) => path.resolve(project));
      if (!allowed.includes(requestedProject)) {
        throw new Error("Use the native project picker before selecting this directory.");
      }
      return this.settings.update({ ...input, selectedProject: requestedProject });
    }
    return this.settings.update(input);
  }

  async configureProvider(input: ConfigureProviderInput): Promise<ConfigureProviderResult> {
    const result = await this.withAuthorizedClient(
      async (client) =>
        (await client.configureProvider(input)) as unknown as ConfigureProviderResult
    );
    if (!result.catalog || !result.selectedModel) {
      throw new Error("Magi returned an invalid provider configuration response.");
    }
    await this.settings.update({ modelAlias: result.selectedModel });
    return result;
  }

  async createSession(input: { cwd: string; title?: string }): Promise<SessionRecord> {
    const settings = await this.settings.get();
    const requestedCwd = path.resolve(input.cwd);
    const allowedProjects = [
      settings.selectedProject,
      ...settings.recentProjects,
      this.serviceStatus.workspace
    ]
      .filter((project): project is string => Boolean(project))
      .map((project) => path.resolve(project));
    if (!allowedProjects.includes(requestedCwd)) {
      throw new Error("Choose this project in Magi Desktop before starting a task in it.");
    }
    if (
      this.serviceStatus.workspace &&
      this.serviceStatus.allowAnyCwd === false &&
      !isPathInside(requestedCwd, this.serviceStatus.workspace)
    ) {
      throw new Error(
        "The existing Magi daemon restricts tasks to its startup workspace. Stop it and reopen Magi Desktop so the desktop-owned daemon can enable selected projects."
      );
    }
    const response = await this.withAuthorizedClient((client) =>
      client.createSession({
        cwd: requestedCwd,
        title: input.title ?? "New task",
        metadata: { source: "desktop" }
      })
    );
    await this.settings.update({ selectedProject: requestedCwd });
    return response.session as SessionRecord;
  }

  async startJob(input: StartJobInput): Promise<JobStartResult> {
    const prompt = encodePromptWithImages(
      input.prompt,
      input.attachments.map(({ mimeType, data }) => ({ mimeType, data }))
    );
    return this.withAuthorizedClient(
      async (client) =>
        (await client.startJob({
          prompt,
          sessionId: input.sessionId,
          modelAlias: input.modelAlias,
          permissionMode: input.permissionMode,
          background: true,
          interactionMode: "client",
          metadata: {
            source: "desktop",
            attachments: input.attachments.map(({ name, mimeType, size }) => ({
              name,
              mimeType,
              size
            }))
          }
        })) as unknown as JobStartResult
    );
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.withAuthorizedClient((client) =>
      client.cancelJob(jobId, "cancelled from Magi Desktop")
    );
  }

  async listEvents(sessionId: string): Promise<MagiEvent[]> {
    return this.withAuthorizedClient(
      async (client) => (await client.listEvents({ sessionId, limit: 250 })).events as MagiEvent[]
    );
  }

  async getInteractions(jobId: string): Promise<ActiveInteraction[]> {
    return this.withAuthorizedClient(
      async (client) => (await client.getJobInteractions(jobId)).interactions as ActiveInteraction[]
    );
  }

  async resolveApproval(jobId: string, toolUseId: string, approved: boolean): Promise<void> {
    await this.withAuthorizedClient((client) =>
      client.resolveApproval(jobId, toolUseId, approved, "Magi Desktop")
    );
  }

  async answerQuestion(
    jobId: string,
    toolUseId: string,
    answer: UserQuestionAnswer
  ): Promise<void> {
    await this.withAuthorizedClient((client) => client.answerQuestion(jobId, toolUseId, answer));
  }

  async subscribe(
    subscriberId: number,
    sessionId: string | undefined,
    send: (event: StreamEnvelope) => void
  ): Promise<void> {
    this.unsubscribe(subscriberId);
    const controller = new AbortController();
    this.subscriptions.set(subscriberId, controller);
    void this.runSubscription(controller, sessionId, send);
  }

  unsubscribe(subscriberId: number): void {
    this.subscriptions.get(subscriberId)?.abort();
    this.subscriptions.delete(subscriberId);
  }

  close(): void {
    for (const controller of this.subscriptions.values()) controller.abort();
    this.subscriptions.clear();
  }

  private async runSubscription(
    controller: AbortController,
    sessionId: string | undefined,
    send: (event: StreamEnvelope) => void
  ): Promise<void> {
    let afterId: number | undefined;
    while (!controller.signal.aborted) {
      try {
        const client = await this.authorizedClient();
        for await (const event of client.streamEvents({
          sessionId,
          afterId,
          limit: 100,
          signal: controller.signal
        })) {
          if (event.id !== undefined) afterId = event.id;
          send(event as StreamEnvelope);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (isUnauthorized(error)) {
          try {
            await this.reauthenticate();
            continue;
          } catch {}
        }
        this.setStatus({
          connected: false,
          phase: "offline",
          message: error instanceof Error ? error.message : String(error)
        });
        await delay(1_500, controller.signal);
        try {
          await this.reconnect();
        } catch {}
      }
    }
  }

  private async authorizedClient(): Promise<MagiHeadlessClient> {
    await this.ensureConnected();
    if (!this.client || !this.serviceStatus.connected) {
      throw new Error(this.serviceStatus.message ?? "Magi service is unavailable");
    }
    return this.client;
  }

  private async withAuthorizedClient<T>(
    operation: (client: MagiHeadlessClient) => Promise<T>
  ): Promise<T> {
    const client = await this.authorizedClient();
    try {
      return await operation(client);
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      return operation(await this.reauthenticate());
    }
  }

  private async reauthenticate(): Promise<MagiHeadlessClient> {
    this.reauthPromise ??= this.pairClient().finally(() => {
      this.reauthPromise = undefined;
    });
    return this.reauthPromise;
  }

  private async pairClient(): Promise<MagiHeadlessClient> {
    if (!this.client) throw new Error("Magi service client is unavailable");
    const paired = await this.client.pair("Magi Desktop", DESKTOP_PAIRING_TTL_MS);
    await this.settings.saveCredentials(paired);
    return this.client;
  }

  private async ensureConnected(): Promise<void> {
    if (this.serviceStatus.connected && this.client) return;
    this.connectPromise ??= this.connect().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async connect(): Promise<void> {
    const desktopSettings = await this.settings.get();
    let activeBaseUrl = desktopSettings.baseUrl;
    this.setStatus({ connected: false, phase: "connecting", message: "Connecting to Magi…" });
    this.client = this.createClient(activeBaseUrl);

    try {
      await this.client.health();
    } catch {
      try {
        activeBaseUrl = await this.startLocalDaemon(activeBaseUrl);
        if (activeBaseUrl !== desktopSettings.baseUrl) {
          await this.settings.setBaseUrl(activeBaseUrl);
          this.client = this.createClient(activeBaseUrl);
        }
        await this.waitForHealth(this.client);
      } catch (error) {
        this.setStatus({
          connected: false,
          phase: "offline",
          message: `Could not start Magi: ${error instanceof Error ? error.message : String(error)}`
        });
        return;
      }
    }

    const credentials = await this.settings.credentials();
    if (credentials) this.client.setCredentials(credentials);
    let status = await this.readServiceStatus();
    let allowAnyCwd = readAllowAnyCwd(status);

    if (shouldUseDesktopDaemon(activeBaseUrl, allowAnyCwd)) {
      try {
        const desktopBaseUrl = await this.startLocalDaemon(activeBaseUrl);
        if (desktopBaseUrl !== activeBaseUrl) await this.settings.setBaseUrl(desktopBaseUrl);
        activeBaseUrl = desktopBaseUrl;
        this.client = this.createClient(activeBaseUrl);
        if (credentials) this.client.setCredentials(credentials);
        await this.waitForHealth(this.client);
        status = await this.readServiceStatus();
        allowAnyCwd = readAllowAnyCwd(status);
        if (allowAnyCwd !== true) {
          throw new Error("the desktop-owned daemon did not enable selected projects");
        }
      } catch (error) {
        this.setStatus({
          connected: false,
          phase: "offline",
          message: `Could not start the desktop-owned Magi service: ${
            error instanceof Error ? error.message : String(error)
          }`
        });
        return;
      }
    }

    this.setStatus({
      connected: true,
      phase: "ready",
      workspace: typeof status.workspace === "string" ? status.workspace : undefined,
      version: typeof status.version === "string" ? status.version : undefined,
      allowAnyCwd
    });
  }

  private async readServiceStatus(): Promise<Record<string, unknown>> {
    if (!this.client) throw new Error("Magi service client is unavailable");
    try {
      return await this.client.status();
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      await this.reauthenticate();
      return this.client.status();
    }
  }

  private async startLocalDaemon(baseUrl: string): Promise<string> {
    const serviceUrl = new URL(baseUrl);
    if (!isLoopbackHost(serviceUrl.hostname)) {
      throw new Error("Automatic daemon startup is only available for loopback service URLs.");
    }
    const port = Number(serviceUrl.port || (serviceUrl.protocol === "https:" ? 443 : 80));
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Invalid Magi service port in ${baseUrl}`);
    }
    const cliPath = this.findCliPath();
    const nodePath = this.findNodePath();
    const daemonEnv = {
      ...process.env,
      MAGI_CONTROL_ALLOW_ANY_CWD: "1",
      MAGI_CONTROL_BIND: "127.0.0.1",
      MAGI_DAEMON_INSTANCE: DESKTOP_DAEMON_INSTANCE
    };
    const existingDaemon = await this.existingDesktopDaemon(
      nodePath,
      cliPath,
      daemonEnv,
      serviceUrl
    );
    if (existingDaemon?.allowAnyCwd === true) return existingDaemon.baseUrl;
    if (existingDaemon) {
      await execFileAsync(nodePath, [cliPath, "daemon", "restart"], {
        cwd: path.dirname(path.dirname(cliPath)),
        timeout: 12_000,
        env: {
          ...daemonEnv,
          MAGI_CONTROL_PORT: String(existingDaemon.port)
        }
      });
      return existingDaemon.baseUrl;
    }

    const availablePort = await findAvailableLoopbackPort(port);
    const activeBaseUrl = withPort(serviceUrl, availablePort);
    await execFileAsync(nodePath, [cliPath, "daemon", "start"], {
      cwd: path.dirname(path.dirname(cliPath)),
      timeout: 12_000,
      env: {
        ...daemonEnv,
        MAGI_CONTROL_PORT: String(availablePort)
      }
    });
    return activeBaseUrl;
  }

  private async existingDesktopDaemon(
    nodePath: string,
    cliPath: string,
    env: NodeJS.ProcessEnv,
    requestedUrl: URL
  ): Promise<ExistingDaemonInfo | undefined> {
    try {
      const { stdout } = await execFileAsync(nodePath, [cliPath, "daemon", "status"], {
        cwd: path.dirname(path.dirname(cliPath)),
        timeout: 5_000,
        env
      });
      const instance = /^Instance:\s+(.+)\s*$/m.exec(stdout)?.[1]?.trim();
      if (instance !== DESKTOP_DAEMON_INSTANCE) return undefined;
      const match = /^Address:\s+.+:(\d+)\s*$/m.exec(stdout);
      if (!match) return undefined;
      const port = Number(match[1]);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
      const allowAnyCwdText = /^Allow any cwd:\s+(yes|no)\s*$/m.exec(stdout)?.[1];
      return {
        baseUrl: withPort(requestedUrl, port),
        port,
        allowAnyCwd: allowAnyCwdText === "yes" ? true : allowAnyCwdText === "no" ? false : undefined
      };
    } catch {
      return undefined;
    }
  }

  private findCliPath(): string {
    const candidates = [
      process.env.MAGI_CLI_PATH,
      path.resolve(app.getAppPath(), "../dist/cli.js"),
      path.resolve(process.cwd(), "../dist/cli.js"),
      path.resolve(process.cwd(), "dist/cli.js"),
      path.join(process.resourcesPath, "magi", "dist", "cli.js")
    ].filter((candidate): candidate is string => Boolean(candidate));
    const match = candidates.find((candidate) => existsSync(candidate));
    if (!match) {
      throw new Error("Magi CLI was not found. Run `npm run build` in the repository first.");
    }
    return match;
  }

  private findNodePath(): string {
    if (process.env.MAGI_NODE_PATH) return process.env.MAGI_NODE_PATH;
    if (!app.isPackaged) return "node";

    const bundledNode = path.join(
      process.resourcesPath,
      "node",
      process.platform === "win32" ? "node.exe" : path.join("bin", "node")
    );
    if (existsSync(bundledNode)) return bundledNode;
    throw new Error(
      `Bundled Node.js runtime was not found at ${bundledNode}. Reinstall Magi Desktop.`
    );
  }

  private async waitForHealth(client: MagiHeadlessClient): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await client.health();
        return;
      } catch (error) {
        lastError = error;
        await delay(250);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Magi did not become ready");
  }

  private setStatus(status: ServiceStatus): void {
    this.serviceStatus = status;
    this.emit("status", status);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

function isControlSession(session: SessionSummary): boolean {
  return /^(control pairing|control approval|control provider configuration|control agent (start|stop|notification))$/i.test(
    session.title?.trim() ?? ""
  );
}

function isUnauthorized(error: unknown): error is HeadlessClientError {
  return error instanceof HeadlessClientError && error.status === 401;
}

function readAllowAnyCwd(status: Record<string, unknown>): boolean | undefined {
  return typeof status.cwdPolicy === "object" &&
    status.cwdPolicy !== null &&
    typeof (status.cwdPolicy as Record<string, unknown>).allowAnyCwd === "boolean"
    ? ((status.cwdPolicy as Record<string, unknown>).allowAnyCwd as boolean)
    : undefined;
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export function shouldUseDesktopDaemon(baseUrl: string, allowAnyCwd: boolean | undefined): boolean {
  try {
    return isLoopbackHost(new URL(baseUrl).hostname) && allowAnyCwd !== true;
  } catch {
    return false;
  }
}

async function findAvailableLoopbackPort(preferredPort: number): Promise<number> {
  for (let offset = 0; offset < 128; offset += 1) {
    const candidate = preferredPort + offset;
    if (candidate > 65_535) break;
    if (await isLoopbackPortAvailable(candidate)) return candidate;
  }
  throw new Error(`No available Magi service port near ${preferredPort}`);
}

function isLoopbackPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    const done = (available: boolean) => {
      server.removeAllListeners();
      resolve(available);
    };
    server.unref();
    server.once("error", () => done(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => done(true));
    });
  });
}

function withPort(input: URL, port: number): string {
  const output = new URL(input);
  output.hostname = "127.0.0.1";
  output.port = String(port);
  output.pathname = "";
  output.search = "";
  output.hash = "";
  return output.toString().replace(/\/$/, "");
}
