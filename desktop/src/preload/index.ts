import { contextBridge, ipcRenderer } from "electron";

import type {
  ConfigureProviderInput,
  MagiDesktopApi,
  ServiceStatus,
  StartJobInput,
  StreamEnvelope,
  UpdateSettingsInput,
  UserQuestionAnswer,
  FamiliarWindowState
} from "../shared/contracts.js";

const api: MagiDesktopApi = {
  bootstrap: () => ipcRenderer.invoke("desktop:bootstrap"),
  chooseProject: () => ipcRenderer.invoke("desktop:choose-project"),
  chooseImages: () => ipcRenderer.invoke("desktop:choose-images"),
  configureProvider: (input: ConfigureProviderInput) =>
    ipcRenderer.invoke("magi:configure-provider", input),
  updateSettings: (input: UpdateSettingsInput) =>
    ipcRenderer.invoke("desktop:update-settings", input),
  listSessions: () => ipcRenderer.invoke("magi:list-sessions"),
  getSession: (id: string) => ipcRenderer.invoke("magi:get-session", id),
  getSessionRuntime: (id: string) => ipcRenderer.invoke("magi:get-session-runtime", id),
  createSession: (input) => ipcRenderer.invoke("magi:create-session", input),
  startJob: (input: StartJobInput) => ipcRenderer.invoke("magi:start-job", input),
  cancelJob: (jobId: string) => ipcRenderer.invoke("magi:cancel-job", jobId),
  listEvents: (sessionId: string) => ipcRenderer.invoke("magi:list-events", sessionId),
  getInteractions: (jobId: string) => ipcRenderer.invoke("magi:get-interactions", jobId),
  resolveApproval: (jobId: string, toolUseId: string, approved: boolean) =>
    ipcRenderer.invoke("magi:resolve-approval", jobId, toolUseId, approved),
  answerQuestion: (jobId: string, toolUseId: string, answer: UserQuestionAnswer) =>
    ipcRenderer.invoke("magi:answer-question", jobId, toolUseId, answer),
  subscribeEvents: (sessionId?: string) => ipcRenderer.invoke("magi:subscribe-events", sessionId),
  unsubscribeEvents: () => ipcRenderer.invoke("magi:unsubscribe-events"),
  setFamiliarVisible: (visible: boolean) =>
    ipcRenderer.invoke("desktop:set-familiar-visible", visible),
  setFamiliarExpanded: (expanded: boolean) =>
    ipcRenderer.invoke("desktop:set-familiar-expanded", expanded),
  revealFamiliar: () => ipcRenderer.invoke("desktop:reveal-familiar"),
  scheduleFamiliarHide: () => ipcRenderer.invoke("desktop:schedule-familiar-hide"),
  openMainWindow: (sessionId?: string) =>
    ipcRenderer.invoke("desktop:open-main-window", sessionId),
  consumeSessionFocus: () => ipcRenderer.invoke("desktop:consume-session-focus"),
  onEvent: (listener: (event: StreamEnvelope) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: StreamEnvelope): void =>
      listener(value);
    ipcRenderer.on("magi:event", wrapped);
    return () => ipcRenderer.removeListener("magi:event", wrapped);
  },
  onServiceStatus: (listener: (status: ServiceStatus) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: ServiceStatus): void =>
      listener(value);
    ipcRenderer.on("magi:service-status", wrapped);
    return () => ipcRenderer.removeListener("magi:service-status", wrapped);
  },
  onFamiliarState: (listener: (state: FamiliarWindowState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: FamiliarWindowState): void =>
      listener(value);
    ipcRenderer.on("desktop:familiar-state", wrapped);
    return () => ipcRenderer.removeListener("desktop:familiar-state", wrapped);
  },
  onSessionFocus: (listener: (sessionId: string) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, sessionId: string): void =>
      listener(sessionId);
    ipcRenderer.on("desktop:session-focus", wrapped);
    return () => ipcRenderer.removeListener("desktop:session-focus", wrapped);
  }
};

contextBridge.exposeInMainWorld("magiDesktop", api);
