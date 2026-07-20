import { beforeEach, describe, expect, it, vi } from "vitest";

import { HeadlessClientError } from "../../dist/control/client.js";

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/tmp/magi/desktop",
    getPath: () => "/tmp/magi-desktop"
  },
  safeStorage: {
    isEncryptionAvailable: () => false
  }
}));

import { MagiServiceManager, shouldUseDesktopDaemon } from "../src/main/service-manager.js";

describe("MagiServiceManager authentication recovery", () => {
  const settings = {
    saveCredentials: vi.fn(),
    update: vi.fn()
  };

  beforeEach(() => {
    settings.saveCredentials.mockReset();
    settings.update.mockReset();
  });

  it("re-pairs once and retries an authenticated request after HTTP 401", async () => {
    const credentials = {
      deviceId: "desktop-refreshed",
      token: "magi_refreshed",
      expiresAt: "2099-01-01T00:00:00.000Z"
    };
    const client = {
      startJob: vi
        .fn()
        .mockRejectedValueOnce(new HeadlessClientError(401, { error: "unauthorized" }, "expired"))
        .mockResolvedValueOnce({ jobId: "job-1", sessionId: "session-1", status: "running" }),
      pair: vi.fn().mockResolvedValue(credentials)
    };
    const manager = new MagiServiceManager(settings as never);
    Object.assign(manager, {
      client,
      serviceStatus: { connected: true, phase: "ready" }
    });

    await expect(
      manager.startJob({
        sessionId: "session-1",
        prompt: "hello",
        modelAlias: "main",
        permissionMode: "default",
        attachments: [
          {
            id: "image-1",
            name: "screen.png",
            mimeType: "image/png",
            size: 5,
            data: "aGVsbG8="
          }
        ]
      })
    ).resolves.toEqual({ jobId: "job-1", sessionId: "session-1", status: "running" });

    expect(client.startJob).toHaveBeenCalledTimes(2);
    expect(client.startJob).toHaveBeenLastCalledWith(
      expect.objectContaining({
        permissionMode: "default",
        interactionMode: "client",
        prompt: expect.stringContaining("<<MAGI_IMAGE:image/png|aGVsbG8="),
        metadata: expect.objectContaining({
          attachments: [{ name: "screen.png", mimeType: "image/png", size: 5 }]
        })
      })
    );
    expect(client.pair).toHaveBeenCalledWith("Magi Desktop", 365 * 24 * 60 * 60_000);
    expect(settings.saveCredentials).toHaveBeenCalledWith(credentials);
  });

  it("configures a provider and persists the selected discovered model", async () => {
    const result = {
      ok: true,
      providerName: "desktop",
      selectedModel: "desktop:coder-main",
      catalog: {
        aliases: {},
        providers: [
          {
            name: "desktop",
            type: "openai",
            protocol: "openai",
            baseUrl: "https://models.example/v1",
            defaultModel: "coder-main",
            models: ["coder-main"],
            configured: true
          }
        ]
      }
    };
    const client = { configureProvider: vi.fn().mockResolvedValue(result) };
    const manager = new MagiServiceManager(settings as never);
    Object.assign(manager, {
      client,
      serviceStatus: { connected: true, phase: "ready" }
    });

    await expect(
      manager.configureProvider({
        providerName: "desktop",
        protocol: "openai",
        baseUrl: "https://models.example/v1",
        apiKey: "secret"
      })
    ).resolves.toEqual(result);
    expect(settings.update).toHaveBeenCalledWith({ modelAlias: "desktop:coder-main" });
  });
});

describe("MagiServiceManager daemon ownership", () => {
  it("switches away from a restricted loopback daemon to the desktop-owned instance", async () => {
    const restrictedUrl = "http://127.0.0.1:8769";
    const desktopUrl = "http://127.0.0.1:8770";
    const restrictedClient = {
      health: vi.fn().mockResolvedValue({ ok: true }),
      status: vi.fn().mockResolvedValue({
        workspace: "/tmp/cli-workspace",
        version: "0.1.13",
        cwdPolicy: { allowAnyCwd: false }
      }),
      listProviders: vi.fn().mockResolvedValue({ providers: [], aliases: { main: "main" } }),
      setCredentials: vi.fn()
    };
    const desktopClient = {
      health: vi.fn().mockResolvedValue({ ok: true }),
      status: vi.fn().mockResolvedValue({
        workspace: "/tmp/desktop-workspace",
        version: "0.1.13",
        cwdPolicy: { allowAnyCwd: true }
      }),
      listProviders: vi.fn().mockResolvedValue({ providers: [], aliases: { main: "main" } }),
      setCredentials: vi.fn()
    };
    const daemonSettings = {
      get: vi.fn().mockResolvedValue({
        baseUrl: restrictedUrl,
        recentProjects: [],
        collapsedProjects: [],
        modelAlias: "main",
        permissionMode: "default",
        rightPanelOpen: true
      }),
      credentials: vi.fn().mockResolvedValue(undefined),
      setBaseUrl: vi.fn(),
      saveCredentials: vi.fn(),
      update: vi.fn()
    };
    const clientFactory = vi.fn((baseUrl: string) =>
      baseUrl === restrictedUrl ? restrictedClient : desktopClient
    );
    const manager = new MagiServiceManager(daemonSettings as never, clientFactory as never);
    const startLocalDaemon = vi.fn().mockResolvedValue(desktopUrl);
    Object.assign(manager, { startLocalDaemon });

    const bootstrap = await manager.bootstrap();

    expect(startLocalDaemon).toHaveBeenCalledWith(restrictedUrl);
    expect(daemonSettings.setBaseUrl).toHaveBeenCalledWith(desktopUrl);
    expect(clientFactory).toHaveBeenCalledWith(restrictedUrl);
    expect(clientFactory).toHaveBeenCalledWith(desktopUrl);
    expect(bootstrap.status).toMatchObject({ connected: true, allowAnyCwd: true });
  });

  it("only replaces loopback services that cannot access selected projects", () => {
    expect(shouldUseDesktopDaemon("http://127.0.0.1:8769", false)).toBe(true);
    expect(shouldUseDesktopDaemon("http://localhost:8769", undefined)).toBe(true);
    expect(shouldUseDesktopDaemon("http://127.0.0.1:8769", true)).toBe(false);
    expect(shouldUseDesktopDaemon("https://magi.example.test", false)).toBe(false);
  });
});
