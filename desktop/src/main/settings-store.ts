import { app, safeStorage } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ControlClientCredentials } from "../../../dist/control/client.js";
import type { DesktopSettings, PermissionMode, UpdateSettingsInput } from "../shared/contracts.js";

interface StoredSettings extends DesktopSettings {
  settingsVersion?: number;
  encryptedCredentials?: string;
}

const SETTINGS_VERSION = 3;
const LEGACY_SHARED_BASE_URL = "http://127.0.0.1:8765";
const DEFAULT_SETTINGS: DesktopSettings = {
  baseUrl: process.env.MAGI_DESKTOP_BASE_URL ?? "http://127.0.0.1:8766",
  recentProjects: [],
  collapsedProjects: [],
  modelAlias: "main",
  permissionMode: "default",
  rightPanelOpen: true,
  familiarEnabled: false
};

const PERMISSION_MODES = new Set<PermissionMode>([
  "default",
  "acceptEdits",
  "dontAsk",
  "bypassPermissions",
  "plan"
]);

export class DesktopSettingsStore {
  private readonly filePath = path.join(app.getPath("userData"), "desktop-settings.json");
  private loaded?: StoredSettings;

  async get(): Promise<DesktopSettings> {
    const stored = await this.load();
    const {
      encryptedCredentials: _credentials,
      settingsVersion: _settingsVersion,
      ...settings
    } = stored;
    return {
      ...settings,
      recentProjects: [...settings.recentProjects],
      collapsedProjects: [...settings.collapsedProjects]
    };
  }

  async update(input: UpdateSettingsInput): Promise<DesktopSettings> {
    const stored = await this.load();
    if (input.modelAlias !== undefined) stored.modelAlias = input.modelAlias;
    if (input.permissionMode !== undefined) stored.permissionMode = input.permissionMode;
    if (input.rightPanelOpen !== undefined) stored.rightPanelOpen = input.rightPanelOpen;
    if (input.familiarEnabled !== undefined) stored.familiarEnabled = input.familiarEnabled;
    if (input.collapsedProjects !== undefined) {
      stored.collapsedProjects = [...new Set(input.collapsedProjects)].slice(0, 50);
    }
    if (input.selectedProject !== undefined) {
      stored.selectedProject = input.selectedProject;
      stored.recentProjects = [
        input.selectedProject,
        ...stored.recentProjects.filter((item) => item !== input.selectedProject)
      ].slice(0, 12);
    }
    await this.persist(stored);
    return this.get();
  }

  async setBaseUrl(baseUrl: string): Promise<void> {
    const stored = await this.load();
    stored.baseUrl = baseUrl;
    await this.persist(stored);
  }

  async credentials(): Promise<ControlClientCredentials | undefined> {
    const stored = await this.load();
    if (!stored.encryptedCredentials || !safeStorage.isEncryptionAvailable()) return undefined;
    try {
      return JSON.parse(
        safeStorage.decryptString(Buffer.from(stored.encryptedCredentials, "base64"))
      ) as ControlClientCredentials;
    } catch {
      return undefined;
    }
  }

  async saveCredentials(credentials: ControlClientCredentials): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) return;
    const stored = await this.load();
    stored.encryptedCredentials = safeStorage
      .encryptString(JSON.stringify(credentials))
      .toString("base64");
    await this.persist(stored);
  }

  private async load(): Promise<StoredSettings> {
    if (this.loaded) return this.loaded;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<StoredSettings>;
      const migrateSharedPort =
        parsed.settingsVersion === undefined &&
        parsed.baseUrl === LEGACY_SHARED_BASE_URL &&
        process.env.MAGI_DESKTOP_BASE_URL === undefined;
      this.loaded = {
        ...DEFAULT_SETTINGS,
        ...parsed,
        settingsVersion: SETTINGS_VERSION,
        baseUrl: migrateSharedPort
          ? DEFAULT_SETTINGS.baseUrl
          : (parsed.baseUrl ?? DEFAULT_SETTINGS.baseUrl),
        recentProjects: Array.isArray(parsed.recentProjects)
          ? parsed.recentProjects.filter((item): item is string => typeof item === "string")
          : [],
        collapsedProjects: Array.isArray(parsed.collapsedProjects)
          ? parsed.collapsedProjects.filter((item): item is string => typeof item === "string")
          : [],
        permissionMode:
          typeof parsed.permissionMode === "string" &&
          PERMISSION_MODES.has(parsed.permissionMode as PermissionMode)
            ? (parsed.permissionMode as PermissionMode)
            : "default"
      };
    } catch {
      this.loaded = { ...DEFAULT_SETTINGS, settingsVersion: SETTINGS_VERSION };
    }
    return this.loaded;
  }

  private async persist(settings: StoredSettings): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.filePath);
    this.loaded = settings;
  }
}
