import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  screen,
  shell,
  type IpcMainInvokeEvent,
  type Rectangle
} from "electron";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ConfigureProviderInput,
  DesktopSettings,
  DesktopImageAttachment,
  FamiliarWindowState,
  PermissionMode,
  StartJobInput,
  UpdateSettingsInput,
  UserQuestionAnswer
} from "../shared/contracts.js";
import { MagiServiceManager } from "./service-manager.js";
import { DesktopSettingsStore } from "./settings-store.js";
import {
  FAMILIAR_COLLAPSED_SIZE,
  FAMILIAR_EXPANDED_SIZE,
  hiddenFamiliarBounds,
  snapFamiliarBounds
} from "./familiar-window.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const appIconPath = path.join(currentDir, "../../resources/icon.png");
const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_MIME_BY_EXTENSION = new Map<string, DesktopImageAttachment["mimeType"]>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"]
]);
let mainWindow: BrowserWindow | undefined;
let familiarWindow: BrowserWindow | undefined;
let service: MagiServiceManager | undefined;
let settings: DesktopSettingsStore | undefined;
let familiarHideTimer: NodeJS.Timeout | undefined;
let familiarSnapTimer: NodeJS.Timeout | undefined;
let familiarBoundsUpdate = false;
let pendingMainSessionId: string | undefined;
let familiarState: FamiliarWindowState = {
  visible: false,
  expanded: false,
  hidden: false
};

function createWindow(): BrowserWindow {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const workArea = display.workArea;
  const width = Math.min(1240, workArea.width - 32);
  const height = Math.min(760, workArea.height - 32);
  const window = new BrowserWindow({
    x: workArea.x + Math.max(0, Math.floor((workArea.width - width) / 2)),
    y: workArea.y + Math.max(0, Math.floor((workArea.height - height) / 2)),
    width,
    height,
    minWidth: Math.min(1050, width),
    minHeight: Math.min(680, height),
    backgroundColor: "#f5f3ee",
    icon: appIconPath,
    title: "Magi",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 18, y: 18 },
    show: false,
    webPreferences: {
      preload: path.join(currentDir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  );
  if (process.env.MAGI_DESKTOP_DEBUG === "1") {
    window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      console.error(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
    window.webContents.on("preload-error", (_event, preloadPath, error) => {
      console.error(`[preload] ${preloadPath}: ${error.stack ?? error.message}`);
    });
    window.webContents.on("did-fail-load", (_event, code, description, url) => {
      console.error(`[load] ${code} ${description}: ${url}`);
    });
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(currentDir, "../renderer/index.html"));
  }
  const screenshotPath = process.env.MAGI_DESKTOP_SCREENSHOT;
  if (screenshotPath) {
    window.webContents.once("did-finish-load", () => {
      setTimeout(() => {
        void window
          .capturePage()
          .then((image) => writeFile(screenshotPath, image.toPNG()))
          .finally(() => app.quit());
      }, 4_000);
    });
  }
  return window;
}

function createFamiliarWindow(): BrowserWindow {
  if (familiarWindow && !familiarWindow.isDestroyed()) return familiarWindow;
  const display = mainWindow
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getPrimaryDisplay();
  const { workArea } = display;
  const width = FAMILIAR_COLLAPSED_SIZE.width;
  const height = FAMILIAR_COLLAPSED_SIZE.height;
  const window = new BrowserWindow({
    x: workArea.x + workArea.width - width - 22,
    y: workArea.y + workArea.height - height - 22,
    width,
    height,
    transparent: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    title: "Magi Familiar",
    webPreferences: {
      preload: path.join(currentDir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  familiarWindow = window;
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  );
  window.once("ready-to-show", () => {
    window.showInactive();
    familiarState = { ...familiarState, visible: true, hidden: false };
    emitFamiliarState();
  });
  window.on("move", () => {
    if (familiarBoundsUpdate || familiarState.hidden || familiarState.expanded) return;
    if (familiarSnapTimer) clearTimeout(familiarSnapTimer);
    familiarSnapTimer = setTimeout(() => snapFamiliarToDisplay(), 180);
  });
  window.on("closed", () => {
    if (familiarHideTimer) clearTimeout(familiarHideTimer);
    if (familiarSnapTimer) clearTimeout(familiarSnapTimer);
    familiarWindow = undefined;
    familiarState = {
      visible: false,
      expanded: false,
      hidden: false
    };
    emitFamiliarState();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = new URL(process.env.ELECTRON_RENDERER_URL);
    rendererUrl.searchParams.set("mode", "familiar");
    void window.loadURL(rendererUrl.toString());
  } else {
    void window.loadFile(path.join(currentDir, "../renderer/index.html"), {
      query: { mode: "familiar" }
    });
  }
  return window;
}

function emitFamiliarState(): void {
  for (const window of [mainWindow, familiarWindow]) {
    if (window && !window.isDestroyed()) {
      window.webContents.send("desktop:familiar-state", familiarState);
    }
  }
}

function applyFamiliarBounds(bounds: Rectangle, animate = true): void {
  if (!familiarWindow || familiarWindow.isDestroyed()) return;
  familiarBoundsUpdate = true;
  familiarWindow.setBounds(bounds, animate);
  setTimeout(() => {
    familiarBoundsUpdate = false;
  }, 120);
}

function snapFamiliarToDisplay(): void {
  if (!familiarWindow || familiarWindow.isDestroyed() || familiarState.expanded) return;
  const bounds = familiarWindow.getBounds();
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const snapped = snapFamiliarBounds(bounds, workArea);
  applyFamiliarBounds(snapped.bounds);
  familiarState = {
    ...familiarState,
    hidden: false,
    edge: snapped.edge
  };
  emitFamiliarState();
  if (snapped.edge) scheduleFamiliarHide();
}

function scheduleFamiliarHide(delay = 1_600): void {
  if (familiarHideTimer) clearTimeout(familiarHideTimer);
  if (!familiarState.edge || familiarState.expanded || familiarState.hidden) return;
  familiarHideTimer = setTimeout(() => hideFamiliarAtEdge(), delay);
}

function hideFamiliarAtEdge(): void {
  if (
    !familiarWindow ||
    familiarWindow.isDestroyed() ||
    !familiarState.edge ||
    familiarState.expanded
  )
    return;
  const bounds = familiarWindow.getBounds();
  const workArea = screen.getDisplayMatching(bounds).workArea;
  applyFamiliarBounds(hiddenFamiliarBounds(bounds, workArea, familiarState.edge));
  familiarState = { ...familiarState, hidden: true };
  emitFamiliarState();
}

function revealFamiliar(): FamiliarWindowState {
  if (!familiarWindow || familiarWindow.isDestroyed()) return familiarState;
  if (familiarHideTimer) clearTimeout(familiarHideTimer);
  if (familiarState.hidden && familiarState.edge) {
    const bounds = familiarWindow.getBounds();
    const workArea = screen.getDisplayMatching(bounds).workArea;
    const x =
      familiarState.edge === "left"
        ? workArea.x
        : workArea.x + workArea.width - bounds.width;
    applyFamiliarBounds({ ...bounds, x });
  }
  familiarWindow.showInactive();
  familiarState = { ...familiarState, visible: true, hidden: false };
  emitFamiliarState();
  return familiarState;
}

function setFamiliarExpanded(expanded: boolean): FamiliarWindowState {
  if (!familiarWindow || familiarWindow.isDestroyed()) return familiarState;
  revealFamiliar();
  const current = familiarWindow.getBounds();
  const workArea = screen.getDisplayMatching(current).workArea;
  const size = expanded ? FAMILIAR_EXPANDED_SIZE : FAMILIAR_COLLAPSED_SIZE;
  let x = Math.min(
    Math.max(current.x, workArea.x),
    workArea.x + workArea.width - size.width
  );
  if (familiarState.edge === "left") x = workArea.x;
  if (familiarState.edge === "right") x = workArea.x + workArea.width - size.width;
  const y = Math.min(
    Math.max(current.y, workArea.y),
    workArea.y + workArea.height - size.height
  );
  familiarState = { ...familiarState, expanded, hidden: false };
  applyFamiliarBounds({ x, y, width: size.width, height: size.height });
  familiarWindow.show();
  if (expanded) familiarWindow.focus();
  else scheduleFamiliarHide(2_000);
  emitFamiliarState();
  return familiarState;
}

async function setFamiliarVisible(
  store: DesktopSettingsStore,
  visible: boolean
): Promise<DesktopSettings> {
  const nextSettings = await store.update({ familiarEnabled: visible });
  if (visible) {
    const window = createFamiliarWindow();
    window.showInactive();
    familiarState = { ...familiarState, visible: true };
    emitFamiliarState();
  } else {
    familiarState = { ...familiarState, visible: false, expanded: false, hidden: false };
    emitFamiliarState();
    setTimeout(() => {
      if (familiarWindow && !familiarWindow.isDestroyed()) familiarWindow.close();
    }, 80);
  }
  return nextSettings;
}

function registerIpc(manager: MagiServiceManager, store: DesktopSettingsStore): void {
  ipcMain.handle("desktop:bootstrap", (event) => {
    assertTrustedIpc(event);
    return manager.bootstrap();
  });
  ipcMain.handle("desktop:choose-project", async (event) => {
    assertTrustedIpc(event);
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Open project",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return undefined;
    await store.update({ selectedProject: result.filePaths[0] });
    return result.filePaths[0];
  });
  ipcMain.handle("desktop:choose-images", async (event) => {
    assertTrustedIpc(event);
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Attach images",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }]
    });
    if (result.canceled) return [];
    if (result.filePaths.length > MAX_IMAGE_ATTACHMENTS) {
      throw new Error(`Choose at most ${MAX_IMAGE_ATTACHMENTS} images at a time.`);
    }
    const attachments: DesktopImageAttachment[] = [];
    let totalBytes = 0;
    for (const filePath of result.filePaths) {
      const mimeType = IMAGE_MIME_BY_EXTENSION.get(path.extname(filePath).toLowerCase());
      if (!mimeType) throw new Error(`Unsupported image type: ${path.basename(filePath)}`);
      const bytes = await readFile(filePath);
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
        throw new Error(
          `${path.basename(filePath)} must be between 1 byte and ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`
        );
      }
      if (nativeImage.createFromBuffer(bytes).isEmpty()) {
        throw new Error(`${path.basename(filePath)} is not a readable image.`);
      }
      totalBytes += bytes.length;
      if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
        throw new Error(
          `Selected images must total at most ${MAX_TOTAL_IMAGE_BYTES / 1024 / 1024} MB.`
        );
      }
      attachments.push({
        id: randomUUID(),
        name: path.basename(filePath),
        mimeType,
        size: bytes.length,
        data: bytes.toString("base64")
      });
    }
    return attachments;
  });
  ipcMain.handle("desktop:update-settings", (event, input: unknown) => {
    assertTrustedIpc(event);
    return manager.updateSettings(readSettingsInput(input));
  });
  ipcMain.handle("desktop:set-familiar-visible", async (event, visible: unknown) => {
    assertTrustedIpc(event);
    if (typeof visible !== "boolean") throw new Error("familiar visibility must be boolean");
    return setFamiliarVisible(store, visible);
  });
  ipcMain.handle("desktop:set-familiar-expanded", (event, expanded: unknown) => {
    assertTrustedIpc(event);
    if (typeof expanded !== "boolean") throw new Error("familiar expansion must be boolean");
    return setFamiliarExpanded(expanded);
  });
  ipcMain.handle("desktop:reveal-familiar", (event) => {
    assertTrustedIpc(event);
    return revealFamiliar();
  });
  ipcMain.handle("desktop:schedule-familiar-hide", (event) => {
    assertTrustedIpc(event);
    scheduleFamiliarHide();
  });
  ipcMain.handle("desktop:open-main-window", (event, sessionId: unknown) => {
    assertTrustedIpc(event);
    const normalizedSessionId =
      sessionId === undefined ? undefined : readString(sessionId, "session id", 256);
    if (normalizedSessionId) pendingMainSessionId = normalizedSessionId;
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
    mainWindow.show();
    mainWindow.focus();
    if (normalizedSessionId) {
      mainWindow.webContents.send("desktop:session-focus", normalizedSessionId);
    }
  });
  ipcMain.handle("desktop:consume-session-focus", (event) => {
    assertTrustedIpc(event);
    const sessionId = pendingMainSessionId;
    pendingMainSessionId = undefined;
    return sessionId;
  });
  ipcMain.handle("magi:configure-provider", (event, input: unknown) => {
    assertTrustedIpc(event);
    return manager.configureProvider(readProviderConnectionInput(input));
  });
  ipcMain.handle("magi:list-sessions", (event) => {
    assertTrustedIpc(event);
    return manager.listSessions();
  });
  ipcMain.handle("magi:get-session", (event, id: unknown) => {
    assertTrustedIpc(event);
    return manager.getSession(readString(id, "session id", 256));
  });
  ipcMain.handle("magi:get-session-runtime", (event, id: unknown) => {
    assertTrustedIpc(event);
    return manager.getSessionRuntime(readString(id, "session id", 256));
  });
  ipcMain.handle("magi:create-session", (event, input: unknown) => {
    assertTrustedIpc(event);
    return manager.createSession(readCreateSessionInput(input));
  });
  ipcMain.handle("magi:start-job", (event, input: unknown) => {
    assertTrustedIpc(event);
    return manager.startJob(readStartJobInput(input));
  });
  ipcMain.handle("magi:cancel-job", (event, jobId: unknown) => {
    assertTrustedIpc(event);
    return manager.cancelJob(readString(jobId, "job id", 256));
  });
  ipcMain.handle("magi:list-events", (event, sessionId: unknown) => {
    assertTrustedIpc(event);
    return manager.listEvents(readString(sessionId, "session id", 256));
  });
  ipcMain.handle("magi:get-interactions", (event, jobId: unknown) => {
    assertTrustedIpc(event);
    return manager.getInteractions(readString(jobId, "job id", 256));
  });
  ipcMain.handle(
    "magi:resolve-approval",
    (event, jobId: unknown, toolUseId: unknown, approved: unknown) => {
      assertTrustedIpc(event);
      if (typeof approved !== "boolean") throw new Error("approval decision must be boolean");
      return manager.resolveApproval(
        readString(jobId, "job id", 256),
        readString(toolUseId, "tool use id", 256),
        approved
      );
    }
  );
  ipcMain.handle(
    "magi:answer-question",
    (event, jobId: unknown, toolUseId: unknown, answer: unknown) => {
      assertTrustedIpc(event);
      return manager.answerQuestion(
        readString(jobId, "job id", 256),
        readString(toolUseId, "tool use id", 256),
        readQuestionAnswer(answer)
      );
    }
  );
  ipcMain.handle("magi:subscribe-events", (event, sessionId?: unknown) => {
    assertTrustedIpc(event);
    const normalizedSessionId =
      sessionId === undefined ? undefined : readString(sessionId, "session id", 256);
    return manager.subscribe(event.sender.id, normalizedSessionId, (envelope) => {
      if (!event.sender.isDestroyed()) event.sender.send("magi:event", envelope);
    });
  });
  ipcMain.handle("magi:unsubscribe-events", (event) => {
    assertTrustedIpc(event);
    return manager.unsubscribe(event.sender.id);
  });
}

function assertTrustedIpc(event: IpcMainInvokeEvent): void {
  const senderWindow = [mainWindow, familiarWindow].find(
    (window) => window && !window.isDestroyed() && event.sender === window.webContents
  );
  if (
    !senderWindow ||
    event.senderFrame !== event.sender.mainFrame ||
    !isTrustedRendererUrl(event.senderFrame.url)
  ) {
    throw new Error("Rejected IPC call from an untrusted renderer");
  }
}

function isTrustedRendererUrl(value: string): boolean {
  try {
    const actual = new URL(value);
    if (process.env.ELECTRON_RENDERER_URL) {
      return actual.origin === new URL(process.env.ELECTRON_RENDERER_URL).origin;
    }
    if (actual.protocol !== "file:") return false;
    return (
      path.resolve(fileURLToPath(actual)) === path.resolve(currentDir, "../renderer/index.html")
    );
  } catch {
    return false;
  }
}

function readString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readSettingsInput(value: unknown): UpdateSettingsInput {
  const input = readRecord(value, "settings");
  const output: UpdateSettingsInput = {};
  if (input.selectedProject !== undefined) {
    output.selectedProject = readString(input.selectedProject, "selected project", 4096);
  }
  if (input.modelAlias !== undefined) {
    output.modelAlias = readString(input.modelAlias, "model alias", 256);
  }
  if (input.permissionMode !== undefined) {
    output.permissionMode = readPermissionMode(input.permissionMode);
  }
  if (input.collapsedProjects !== undefined) {
    if (!Array.isArray(input.collapsedProjects) || input.collapsedProjects.length > 50) {
      throw new Error("collapsedProjects must be an array with at most 50 paths");
    }
    output.collapsedProjects = input.collapsedProjects.map((project, index) =>
      readString(project, `collapsed project ${index + 1}`, 4096)
    );
  }
  if (input.rightPanelOpen !== undefined) {
    if (typeof input.rightPanelOpen !== "boolean") {
      throw new Error("rightPanelOpen must be boolean");
    }
    output.rightPanelOpen = input.rightPanelOpen;
  }
  if (input.familiarEnabled !== undefined) {
    if (typeof input.familiarEnabled !== "boolean") {
      throw new Error("familiarEnabled must be boolean");
    }
    output.familiarEnabled = input.familiarEnabled;
  }
  return output;
}

function readProviderConnectionInput(value: unknown): ConfigureProviderInput {
  const input = readRecord(value, "provider connection");
  if (input.protocol !== "openai" && input.protocol !== "anthropic") {
    throw new Error("provider protocol must be openai or anthropic");
  }
  return {
    providerName: readString(input.providerName, "provider name", 64),
    protocol: input.protocol,
    baseUrl: readString(input.baseUrl, "provider base URL", 2_048),
    apiKey: readString(input.apiKey, "provider API key", 16_384)
  };
}

function readCreateSessionInput(value: unknown): { cwd: string; title?: string } {
  const input = readRecord(value, "session input");
  return {
    cwd: readString(input.cwd, "working directory", 4096),
    title: input.title === undefined ? undefined : readString(input.title, "session title", 256)
  };
}

function readStartJobInput(value: unknown): StartJobInput {
  const input = readRecord(value, "job input");
  return {
    sessionId: readString(input.sessionId, "session id", 256),
    prompt: readString(input.prompt, "prompt", 500_000),
    modelAlias: readString(input.modelAlias, "model alias", 256),
    permissionMode: readPermissionMode(input.permissionMode),
    attachments: readImageAttachments(input.attachments)
  };
}

function readImageAttachments(value: unknown): DesktopImageAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGE_ATTACHMENTS) {
    throw new Error(`attachments must contain at most ${MAX_IMAGE_ATTACHMENTS} images`);
  }
  let totalBytes = 0;
  return value.map((raw, index) => {
    const attachment = readRecord(raw, `attachment ${index + 1}`);
    const mimeType = attachment.mimeType;
    if (
      mimeType !== "image/png" &&
      mimeType !== "image/jpeg" &&
      mimeType !== "image/gif" &&
      mimeType !== "image/webp"
    ) {
      throw new Error(`attachment ${index + 1} has an unsupported image type`);
    }
    const data = attachment.data;
    if (
      typeof data !== "string" ||
      data.length === 0 ||
      data.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
    ) {
      throw new Error(`attachment ${index + 1} has invalid image data`);
    }
    const decodedBytes = Buffer.byteLength(data, "base64");
    if (decodedBytes === 0 || decodedBytes > MAX_IMAGE_BYTES) {
      throw new Error(`attachment ${index + 1} exceeds the image size limit`);
    }
    totalBytes += decodedBytes;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new Error("attachments exceed the total image size limit");
    }
    return {
      id: readString(attachment.id, `attachment ${index + 1} id`, 128),
      name: readString(attachment.name, `attachment ${index + 1} name`, 512),
      mimeType,
      size: decodedBytes,
      data
    };
  });
}

function readPermissionMode(value: unknown): PermissionMode {
  if (
    value === "default" ||
    value === "acceptEdits" ||
    value === "dontAsk" ||
    value === "bypassPermissions" ||
    value === "plan"
  ) {
    return value;
  }
  throw new Error(
    "permissionMode must be default, acceptEdits, dontAsk, bypassPermissions, or plan"
  );
}

function readQuestionAnswer(value: unknown): UserQuestionAnswer {
  const input = readRecord(value, "question answer");
  if (!Array.isArray(input.answers) || input.answers.length < 1 || input.answers.length > 4) {
    throw new Error("question answer must contain 1 to 4 answers");
  }
  return {
    answers: input.answers.map((raw, index) => {
      const answer = readRecord(raw, `answer ${index + 1}`);
      if (
        !Array.isArray(answer.selectedLabels) ||
        answer.selectedLabels.length < 1 ||
        answer.selectedLabels.length > 4
      ) {
        throw new Error(`answer ${index + 1} must select 1 to 4 labels`);
      }
      return {
        question: readString(answer.question, `answer ${index + 1} question`, 2_000),
        selectedLabels: answer.selectedLabels.map((label) =>
          readString(label, `answer ${index + 1} label`, 256)
        )
      };
    })
  };
}

if (process.env.MAGI_DESKTOP_USER_DATA) {
  app.setPath("userData", process.env.MAGI_DESKTOP_USER_DATA);
}

app.setName("Magi");

app.whenReady().then(() => {
  if (process.platform === "darwin") {
    const icon = nativeImage.createFromPath(appIconPath);
    if (!icon.isEmpty()) app.dock?.setIcon(icon);
  }
  settings = new DesktopSettingsStore();
  service = new MagiServiceManager(settings);
  registerIpc(service, settings);
  mainWindow = createWindow();
  void settings.get().then((stored) => {
    if (stored.familiarEnabled || process.env.MAGI_DESKTOP_FAMILIAR === "1") {
      createFamiliarWindow();
    }
  });
  service.on("status", (status) => {
    for (const window of [mainWindow, familiarWindow]) {
      if (window && !window.isDestroyed()) {
        window.webContents.send("magi:service-status", status);
      }
    }
  });

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
    else mainWindow.show();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => service?.close());
