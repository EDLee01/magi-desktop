export interface SessionSummary {
  id: string;
  title: string | null;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface SessionMessage {
  id: number;
  sessionId: string;
  role: string;
  content: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface SessionRecord extends Omit<SessionSummary, "messageCount"> {
  metadata: Record<string, unknown>;
  messages: SessionMessage[];
}

export interface MagiEvent {
  id: number;
  sessionId: string;
  jobId?: string;
  eventName: string;
  action: string;
  category: string;
  status: string;
  target?: string;
  createdAt: string;
  message: string;
  metadata: Record<string, unknown>;
}

export interface JobStartResult {
  jobId: string;
  sessionId: string;
  status?: string;
}

export interface JobRecord {
  id: string;
  sessionId: string;
  kind: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderInfo {
  name: string;
  type: string;
  protocol: ProviderProtocol;
  baseUrl?: string;
  defaultModel: string;
  models: string[];
  configured: boolean;
}

export interface ProviderCatalog {
  providers: ProviderInfo[];
  aliases: Record<string, string>;
  modelCapabilities?: Record<string, ModelCapability>;
}

export interface ModelCapability {
  supportsVision: boolean;
}

export interface ConfigureProviderInput {
  providerName: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey: string;
}

export type ProviderProtocol = "openai" | "anthropic";

export interface ConfigureProviderResult {
  ok: boolean;
  providerName: string;
  selectedModel: string;
  catalog: ProviderCatalog;
}

export interface DesktopImageAttachment {
  id: string;
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  size: number;
  /** Base64-encoded bytes without a data URL prefix. */
  data: string;
}

export interface ActiveInteraction {
  kind: "approval" | "question";
  status: "pending" | "resolved" | "timeout" | "cancelled";
  sessionId: string;
  jobId: string;
  toolUseId: string;
  toolName: string;
  createdAt: string;
  updatedAt: string;
  timeoutAt?: string;
  reason?: string;
  toolUse: {
    id: string;
    name: string;
    input?: Record<string, unknown>;
  };
  question?: {
    questions?: Array<{
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;
  };
}

export interface SessionRuntime {
  activeJob?: JobRecord;
  interactions: ActiveInteraction[];
}

export interface UserQuestionAnswer extends Record<string, unknown> {
  answers: Array<{
    question: string;
    selectedLabels: string[];
  }>;
}

export type PermissionMode = "default" | "acceptEdits" | "dontAsk" | "bypassPermissions" | "plan";

export interface DesktopSettings {
  baseUrl: string;
  recentProjects: string[];
  collapsedProjects: string[];
  selectedProject?: string;
  modelAlias: string;
  permissionMode: PermissionMode;
  rightPanelOpen: boolean;
  familiarEnabled: boolean;
}

export interface FamiliarWindowState {
  visible: boolean;
  expanded: boolean;
  hidden: boolean;
  edge?: "left" | "right";
}

export interface ServiceStatus {
  connected: boolean;
  phase: "connecting" | "ready" | "offline";
  message?: string;
  workspace?: string;
  version?: string;
  allowAnyCwd?: boolean;
}

export interface DesktopBootstrap {
  settings: DesktopSettings;
  status: ServiceStatus;
  providers: ProviderCatalog;
}

export interface StreamEnvelope {
  id?: number;
  event: string;
  data: MagiEvent;
}

export interface StartJobInput {
  sessionId: string;
  prompt: string;
  modelAlias: string;
  permissionMode: PermissionMode;
  attachments: DesktopImageAttachment[];
}

export interface UpdateSettingsInput {
  selectedProject?: string;
  collapsedProjects?: string[];
  modelAlias?: string;
  permissionMode?: PermissionMode;
  rightPanelOpen?: boolean;
  familiarEnabled?: boolean;
}

export interface MagiDesktopApi {
  bootstrap(): Promise<DesktopBootstrap>;
  chooseProject(): Promise<string | undefined>;
  chooseImages(): Promise<DesktopImageAttachment[]>;
  configureProvider(input: ConfigureProviderInput): Promise<ConfigureProviderResult>;
  updateSettings(input: UpdateSettingsInput): Promise<DesktopSettings>;
  listSessions(): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionRecord>;
  getSessionRuntime(id: string): Promise<SessionRuntime>;
  createSession(input: { cwd: string; title?: string }): Promise<SessionRecord>;
  startJob(input: StartJobInput): Promise<JobStartResult>;
  cancelJob(jobId: string): Promise<void>;
  listEvents(sessionId: string): Promise<MagiEvent[]>;
  getInteractions(jobId: string): Promise<ActiveInteraction[]>;
  resolveApproval(jobId: string, toolUseId: string, approved: boolean): Promise<void>;
  answerQuestion(jobId: string, toolUseId: string, answer: UserQuestionAnswer): Promise<void>;
  subscribeEvents(sessionId?: string): Promise<void>;
  unsubscribeEvents(): Promise<void>;
  setFamiliarVisible(visible: boolean): Promise<DesktopSettings>;
  setFamiliarExpanded(expanded: boolean): Promise<FamiliarWindowState>;
  revealFamiliar(): Promise<FamiliarWindowState>;
  scheduleFamiliarHide(): Promise<void>;
  openMainWindow(sessionId?: string): Promise<void>;
  consumeSessionFocus(): Promise<string | undefined>;
  onEvent(listener: (event: StreamEnvelope) => void): () => void;
  onServiceStatus(listener: (status: ServiceStatus) => void): () => void;
  onFamiliarState(listener: (state: FamiliarWindowState) => void): () => void;
  onSessionFocus(listener: (sessionId: string) => void): () => void;
}
