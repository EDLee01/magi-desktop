import {
  Activity,
  AlertCircle,
  ArrowUp,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  FileCode2,
  Folder,
  FolderOpen,
  GitBranch,
  Image as ImageIcon,
  LoaderCircle,
  MessageSquarePlus,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  WandSparkles,
  X,
  XCircle
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ActiveInteraction,
  ConfigureProviderInput,
  ConfigureProviderResult,
  DesktopBootstrap,
  DesktopImageAttachment,
  MagiEvent,
  PermissionMode,
  ProviderProtocol,
  ServiceStatus,
  SessionMessage,
  SessionRecord,
  SessionSummary,
  UserQuestionAnswer
} from "../../shared/contracts";
import {
  compactPath,
  buildModelOptions,
  eventDelta,
  groupSessions,
  isChangeEvent,
  isTerminalEvent,
  mergeEvents,
  permissionModeLabel,
  projectName,
  streamedTextForJob,
  toggleProjectPath
} from "./state";
import { MarkdownMessage } from "./MarkdownMessage";

type RightTab = "activity" | "changes";

const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;

interface LiveDraft {
  jobId: string;
  text: string;
}

export function App(): React.JSX.Element {
  const [bootstrap, setBootstrap] = useState<DesktopBootstrap>();
  const [status, setStatus] = useState<ServiceStatus>({ connected: false, phase: "connecting" });
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>();
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [session, setSession] = useState<SessionRecord>();
  const [events, setEvents] = useState<MagiEvent[]>([]);
  const [interactions, setInteractions] = useState<ActiveInteraction[]>([]);
  const [activeJobId, setActiveJobId] = useState<string>();
  const [liveDraft, setLiveDraft] = useState<LiveDraft>();
  const [optimisticMessage, setOptimisticMessage] = useState<string>();
  const [composer, setComposer] = useState("");
  const [attachments, setAttachments] = useState<DesktopImageAttachment[]>([]);
  const [modelAlias, setModelAlias] = useState("main");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [rightTab, setRightTab] = useState<RightTab>("activity");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [familiarEnabled, setFamiliarEnabled] = useState(false);
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [error, setError] = useState<string>();
  const [loadingSession, setLoadingSession] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const permissionMenuRef = useRef<HTMLDivElement>(null);
  const eventsRef = useRef<MagiEvent[]>([]);
  const seenEventIds = useRef(new Set<number>());
  const terminalJobIds = useRef(new Set<string>());
  const loadRequestId = useRef(0);
  const selectedSessionIdRef = useRef<string | undefined>(undefined);
  selectedSessionIdRef.current = selectedSessionId;

  const loadSessions = useCallback(async (): Promise<SessionSummary[]> => {
    const next = await window.magiDesktop.listSessions();
    setSessions(next);
    return next;
  }, []);

  const loadSession = useCallback(async (id: string): Promise<void> => {
    const requestId = ++loadRequestId.current;
    setLoadingSession(true);
    setError(undefined);
    try {
      const [nextSession, nextEvents] = await Promise.all([
        window.magiDesktop.getSession(id),
        window.magiDesktop.listEvents(id)
      ]);
      const runtime = await window.magiDesktop.getSessionRuntime(id);
      if (requestId !== loadRequestId.current || selectedSessionIdRef.current !== id) return;
      const orderedEvents = [...nextEvents].sort((left, right) => left.id - right.id);
      for (const event of orderedEvents) seenEventIds.current.add(event.id);
      const activeJob =
        runtime.activeJob &&
        !terminalJobIds.current.has(runtime.activeJob.id) &&
        !orderedEvents.some(
          (event) => event.jobId === runtime.activeJob?.id && isTerminalEvent(event)
        )
          ? runtime.activeJob
          : undefined;
      const mergedEvents = mergeEvents(
        orderedEvents,
        eventsRef.current.filter((event) => event.sessionId === id)
      );
      eventsRef.current = mergedEvents;
      setSession(nextSession);
      setEvents(mergedEvents);
      setActiveJobId(activeJob?.id);
      setInteractions(activeJob ? runtime.interactions : []);
      setLiveDraft(
        activeJob
          ? {
              jobId: activeJob.id,
              text: streamedTextForJob(mergedEvents, activeJob.id)
            }
          : undefined
      );
      setOptimisticMessage(undefined);
    } catch (nextError) {
      if (requestId === loadRequestId.current && selectedSessionIdRef.current === id) {
        setError(errorMessage(nextError));
      }
    } finally {
      if (requestId === loadRequestId.current) setLoadingSession(false);
    }
  }, []);

  const refreshInteractions = useCallback(async (jobId: string): Promise<void> => {
    try {
      const next = await window.magiDesktop.getInteractions(jobId);
      setInteractions(next.filter((interaction) => interaction.status === "pending"));
    } catch {}
  }, []);

  const focusSessionFromFamiliar = useCallback(
    async (sessionId: string): Promise<void> => {
      try {
        const target = await window.magiDesktop.getSession(sessionId);
        setSelectedProject(target.cwd);
        setSelectedSessionId(sessionId);
        setBootstrap((current) =>
          current
            ? {
                ...current,
                settings: {
                  ...current.settings,
                  selectedProject: target.cwd,
                  recentProjects: [
                    target.cwd,
                    ...current.settings.recentProjects.filter((item) => item !== target.cwd)
                  ]
                }
              }
            : current
        );
        await Promise.all([
          window.magiDesktop.updateSettings({ selectedProject: target.cwd }),
          loadSessions()
        ]);
      } catch (nextError) {
        setError(errorMessage(nextError));
      }
    },
    [loadSessions]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const initial = await window.magiDesktop.bootstrap();
        if (cancelled) return;
        setBootstrap(initial);
        setStatus(initial.status);
        setModelAlias(initial.settings.modelAlias);
        setPermissionMode(initial.settings.permissionMode);
        setCollapsedProjects(initial.settings.collapsedProjects);
        setRightPanelOpen(initial.settings.rightPanelOpen);
        setFamiliarEnabled(initial.settings.familiarEnabled);
        const nextSessions = initial.status.connected ? await loadSessions() : [];
        if (cancelled) return;
        const project =
          initial.settings.selectedProject ??
          initial.settings.recentProjects[0] ??
          initial.status.workspace ??
          nextSessions[0]?.cwd;
        setSelectedProject(project);
        if (project && initial.settings.selectedProject !== project) {
          void window.magiDesktop.updateSettings({ selectedProject: project });
        }
        const first = nextSessions.find((item) => item.cwd === project) ?? nextSessions[0];
        if (first) setSelectedSessionId(first.id);
        const requestedSessionId = await window.magiDesktop.consumeSessionFocus();
        if (requestedSessionId && !cancelled) {
          await focusSessionFromFamiliar(requestedSessionId);
        }
      } catch (nextError) {
        if (!cancelled) {
          setStatus({ connected: false, phase: "offline", message: errorMessage(nextError) });
          setError(errorMessage(nextError));
        }
      }
    })();
    const removeStatus = window.magiDesktop.onServiceStatus(setStatus);
    const removeFamiliarState = window.magiDesktop.onFamiliarState((nextState) =>
      setFamiliarEnabled(nextState.visible)
    );
    return () => {
      cancelled = true;
      removeStatus();
      removeFamiliarState();
    };
  }, [focusSessionFromFamiliar, loadSessions]);

  useEffect(() => {
    let active = true;
    const focusSession = (sessionId: string): void => {
      if (active) void focusSessionFromFamiliar(sessionId);
    };
    const removeFocus = window.magiDesktop.onSessionFocus(focusSession);
    return () => {
      active = false;
      removeFocus();
    };
  }, [focusSessionFromFamiliar]);

  useEffect(() => {
    if (!selectedSessionId || !status.connected) {
      loadRequestId.current += 1;
      setSession(undefined);
      eventsRef.current = [];
      setEvents([]);
      setActiveJobId(undefined);
      setInteractions([]);
      setLiveDraft(undefined);
      return;
    }
    eventsRef.current = eventsRef.current.filter((event) => event.sessionId === selectedSessionId);
    setEvents(eventsRef.current);
    void loadSession(selectedSessionId);
    void window.magiDesktop.subscribeEvents(selectedSessionId);
    return () => {
      void window.magiDesktop.unsubscribeEvents();
    };
  }, [loadSession, selectedSessionId, status.connected]);

  useEffect(() => {
    return window.magiDesktop.onEvent((envelope) => {
      const event = envelope.data;
      if (!event || event.sessionId !== selectedSessionId || seenEventIds.current.has(event.id))
        return;
      seenEventIds.current.add(event.id);
      eventsRef.current = mergeEvents(eventsRef.current, event);
      setEvents(eventsRef.current);

      const delta = eventDelta(event);
      if (delta && event.jobId) {
        setLiveDraft((current) => ({
          jobId: event.jobId!,
          text: current && current.jobId === event.jobId ? current.text + delta : delta
        }));
      }
      if (
        event.jobId &&
        (event.action === "agent.approval.pending" ||
          event.action === "agent.user_question.pending")
      ) {
        void refreshInteractions(event.jobId);
      }
      if (isTerminalEvent(event)) {
        if (event.jobId) terminalJobIds.current.add(event.jobId);
        setActiveJobId((current) => (current === event.jobId ? undefined : current));
        setInteractions([]);
        if (selectedSessionId) {
          void loadSession(selectedSessionId);
          void loadSessions();
        }
      }
    });
  }, [loadSession, loadSessions, refreshInteractions, selectedSessionId]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [session?.messages.length, liveDraft?.text, optimisticMessage, interactions.length]);

  useEffect(() => {
    if (!permissionMenuOpen) return;
    const closeOnOutsideClick = (event: MouseEvent): void => {
      if (!permissionMenuRef.current?.contains(event.target as Node)) {
        setPermissionMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setPermissionMenuOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [permissionMenuOpen]);

  const groups = useMemo(
    () =>
      groupSessions(
        sessions,
        [selectedProject, ...(bootstrap?.settings.recentProjects ?? [])].filter(
          (project): project is string => Boolean(project)
        )
      ),
    [bootstrap?.settings.recentProjects, selectedProject, sessions]
  );
  const visibleGroups = useMemo(() => {
    const needle = sidebarSearch.trim().toLowerCase();
    if (!needle) return groups;
    return groups
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter((item) =>
          `${item.title ?? "New task"} ${item.cwd}`.toLowerCase().includes(needle)
        )
      }))
      .filter((group) => group.name.toLowerCase().includes(needle) || group.sessions.length > 0);
  }, [groups, sidebarSearch]);
  const modelOptions = buildModelOptions(bootstrap?.providers, modelAlias);
  const selectedModelCapability = bootstrap?.providers.modelCapabilities?.[modelAlias];
  const selectedModelSupportsImages =
    modelAlias === "auto" ? true : selectedModelCapability?.supportsVision;
  const canSendPrompt =
    Boolean(composer.trim() || attachments.length > 0) && selectedModelSupportsImages !== false;
  const activityEvents = events
    .filter((event) => event.action !== "agent.text.delta")
    .slice(-80)
    .reverse();
  const changeEvents = events.filter(isChangeEvent).slice(-80).reverse();
  const terminalEvents = events
    .filter(
      (event) =>
        event.target === "Bash" ||
        event.target === "Shell" ||
        event.category === "runner" ||
        event.action === "agent.tool.failed"
    )
    .slice(-30);

  async function chooseProject(): Promise<void> {
    const selected = await window.magiDesktop.chooseProject();
    if (!selected) return;
    setSelectedProject(selected);
    setSelectedSessionId(sessions.find((item) => item.cwd === selected)?.id);
    setSession(undefined);
    setComposer("");
    setAttachments([]);
    setBootstrap((current) =>
      current
        ? {
            ...current,
            settings: {
              ...current.settings,
              selectedProject: selected,
              recentProjects: [
                selected,
                ...current.settings.recentProjects.filter((item) => item !== selected)
              ]
            }
          }
        : current
    );
  }

  async function selectProject(projectPath: string): Promise<void> {
    setSelectedProject(projectPath);
    await window.magiDesktop.updateSettings({ selectedProject: projectPath });
    const first = sessions
      .filter((item) => item.cwd === projectPath)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    setSelectedSessionId(first?.id);
  }

  async function toggleProject(projectPath: string): Promise<void> {
    const next = toggleProjectPath(collapsedProjects, projectPath);
    setCollapsedProjects(next);
    setBootstrap((current) =>
      current
        ? {
            ...current,
            settings: { ...current.settings, collapsedProjects: next }
          }
        : current
    );
    try {
      await window.magiDesktop.updateSettings({ collapsedProjects: next });
    } catch (nextError) {
      setCollapsedProjects(collapsedProjects);
      setError(errorMessage(nextError));
    }
  }

  async function selectSession(item: SessionSummary): Promise<void> {
    setSelectedProject(item.cwd);
    setSelectedSessionId(item.id);
    await window.magiDesktop.updateSettings({ selectedProject: item.cwd });
  }

  async function createNewTask(): Promise<void> {
    if (!selectedProject) {
      await chooseProject();
      return;
    }
    try {
      const created = await window.magiDesktop.createSession({ cwd: selectedProject });
      await loadSessions();
      setSelectedSessionId(created.id);
      setComposer("");
      setAttachments([]);
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  }

  async function chooseImages(): Promise<void> {
    if (activeJobId || loadingSession) return;
    try {
      const selected = await window.magiDesktop.chooseImages();
      if (selected.length === 0) return;
      const next = [...attachments, ...selected];
      if (next.length > MAX_IMAGE_ATTACHMENTS) {
        setError(`You can attach at most ${MAX_IMAGE_ATTACHMENTS} images.`);
        return;
      }
      if (next.reduce((total, item) => total + item.size, 0) > MAX_TOTAL_IMAGE_BYTES) {
        setError(`Attached images must total at most ${MAX_TOTAL_IMAGE_BYTES / 1024 / 1024} MB.`);
        return;
      }
      setAttachments(next);
      setError(undefined);
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  }

  function removeImage(id: string): void {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  async function sendPrompt(): Promise<void> {
    const typedPrompt = composer.trim();
    const pendingAttachments = attachments;
    const prompt =
      typedPrompt ||
      (pendingAttachments.length === 1
        ? "Analyze the attached image."
        : "Analyze and compare the attached images.");
    if (
      (!typedPrompt && pendingAttachments.length === 0) ||
      activeJobId ||
      loadingSession ||
      selectedModelSupportsImages === false
    )
      return;
    if (!selectedProject) {
      await chooseProject();
      return;
    }
    loadRequestId.current += 1;
    setLoadingSession(false);
    setError(undefined);
    setComposer("");
    setOptimisticMessage(prompt);
    try {
      let sessionId = selectedSessionId;
      if (!sessionId) {
        const created = await window.magiDesktop.createSession({
          cwd: selectedProject,
          title: prompt.slice(0, 64)
        });
        sessionId = created.id;
        setSelectedSessionId(created.id);
        setSession(created);
        await window.magiDesktop.subscribeEvents(created.id);
      }
      const result = await window.magiDesktop.startJob({
        sessionId,
        prompt,
        modelAlias,
        permissionMode,
        attachments: pendingAttachments
      });
      loadRequestId.current += 1;
      setLoadingSession(false);
      setActiveJobId(result.jobId);
      setLiveDraft((current) =>
        current?.jobId === result.jobId ? current : { jobId: result.jobId, text: "" }
      );
      setAttachments([]);
      await loadSessions();
    } catch (nextError) {
      setError(errorMessage(nextError));
      if (typedPrompt) setComposer((current) => current || typedPrompt);
      setOptimisticMessage(undefined);
      setActiveJobId(undefined);
    }
  }

  async function cancelJob(): Promise<void> {
    if (!activeJobId) return;
    try {
      await window.magiDesktop.cancelJob(activeJobId);
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  }

  async function setModel(value: string): Promise<void> {
    setModelAlias(value);
    await window.magiDesktop.updateSettings({ modelAlias: value });
  }

  async function configureProvider(
    input: ConfigureProviderInput
  ): Promise<ConfigureProviderResult> {
    const result = await window.magiDesktop.configureProvider(input);
    setModelAlias(result.selectedModel);
    setBootstrap((current) =>
      current
        ? {
            ...current,
            providers: result.catalog,
            settings: { ...current.settings, modelAlias: result.selectedModel }
          }
        : current
    );
    setError(undefined);
    return result;
  }

  async function updatePermissionMode(value: PermissionMode): Promise<void> {
    const previous = permissionMode;
    setPermissionMode(value);
    setBootstrap((current) =>
      current ? { ...current, settings: { ...current.settings, permissionMode: value } } : current
    );
    try {
      await window.magiDesktop.updateSettings({ permissionMode: value });
    } catch (nextError) {
      setPermissionMode(previous);
      setError(errorMessage(nextError));
    }
  }

  async function toggleRightPanel(): Promise<void> {
    const next = !rightPanelOpen;
    setRightPanelOpen(next);
    await window.magiDesktop.updateSettings({ rightPanelOpen: next });
  }

  async function toggleFamiliar(): Promise<void> {
    const previous = familiarEnabled;
    const next = !previous;
    setFamiliarEnabled(next);
    try {
      const nextSettings = await window.magiDesktop.setFamiliarVisible(next);
      setFamiliarEnabled(nextSettings.familiarEnabled);
      setBootstrap((current) =>
        current
          ? {
              ...current,
              settings: { ...current.settings, familiarEnabled: nextSettings.familiarEnabled }
            }
          : current
      );
    } catch (nextError) {
      setFamiliarEnabled(previous);
      setError(errorMessage(nextError));
    }
  }

  async function resolveApproval(interaction: ActiveInteraction, approved: boolean): Promise<void> {
    try {
      await window.magiDesktop.resolveApproval(interaction.jobId, interaction.toolUseId, approved);
      await refreshInteractions(interaction.jobId);
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  }

  async function answerQuestion(
    interaction: ActiveInteraction,
    answer: UserQuestionAnswer
  ): Promise<void> {
    try {
      await window.magiDesktop.answerQuestion(interaction.jobId, interaction.toolUseId, answer);
      await refreshInteractions(interaction.jobId);
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  }

  const messages = session?.messages ?? [];
  const hasConversation = messages.length > 0 || optimisticMessage || liveDraft;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="window-drag" />
        <div className="brand-row">
          <img src="./magi-mark.svg" alt="" className="brand-mark" />
          <span className="brand-name">Magi</span>
        </div>

        <button className="new-task-button" onClick={() => void createNewTask()}>
          <MessageSquarePlus size={16} />
          <span>New task</span>
          <kbd>⌘N</kbd>
        </button>

        <label className="sidebar-search">
          <Search size={14} />
          <input
            value={sidebarSearch}
            onChange={(event) => setSidebarSearch(event.target.value)}
            placeholder="Search tasks"
          />
        </label>

        <div className="sidebar-scroll">
          <div className="section-kicker">
            <span>Projects</span>
            <button
              onClick={() => void chooseProject()}
              aria-label="Open project"
              title="Open project"
            >
              <Plus size={14} />
            </button>
          </div>
          {visibleGroups.map((group) => {
            const collapsed = collapsedProjects.includes(group.path) && !sidebarSearch.trim();
            return (
              <div className="project-block" key={group.path}>
                <div className={`project-row ${selectedProject === group.path ? "selected" : ""}`}>
                  <button
                    className="project-button"
                    onClick={() => void selectProject(group.path)}
                    title={`Use ${group.path}`}
                  >
                    {selectedProject === group.path ? (
                      <FolderOpen size={15} />
                    ) : (
                      <Folder size={15} />
                    )}
                    <span>{group.name}</span>
                  </button>
                  <button
                    className="project-collapse"
                    onClick={() => void toggleProject(group.path)}
                    aria-expanded={!collapsed}
                    aria-label={`${collapsed ? "Expand" : "Collapse"} ${group.name}`}
                    title={`${collapsed ? "Expand" : "Collapse"} project`}
                  >
                    {collapsed ? (
                      <ChevronRight size={13} className="project-chevron" />
                    ) : (
                      <ChevronDown size={13} className="project-chevron" />
                    )}
                  </button>
                </div>
                {!collapsed && (
                  <div className="task-list">
                    {group.sessions.map((item) => (
                      <button
                        key={item.id}
                        className={`task-button ${selectedSessionId === item.id ? "selected" : ""}`}
                        onClick={() => void selectSession(item)}
                      >
                        <span className="task-title">{item.title || "New task"}</span>
                        {item.messageCount > 0 && (
                          <span className="task-count">{item.messageCount}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {visibleGroups.length === 0 && (
            <button className="empty-projects" onClick={() => void chooseProject()}>
              <FolderOpen size={17} />
              Open your first project
            </button>
          )}
        </div>

        <div className="sidebar-footer">
          <div className={`connection-dot ${status.phase}`} />
          <div className="connection-copy">
            <strong>{status.phase === "ready" ? "Local agent ready" : status.phase}</strong>
            <span>{status.version ? `Magi ${status.version}` : "127.0.0.1:8765"}</span>
          </div>
          <button
            className="settings-button"
            aria-label="Settings"
            title="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={14} strokeWidth={2.1} />
            <span>Settings</span>
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div className="header-title">
            <strong>{session?.title || (selectedProject ? "New task" : "Magi")}</strong>
            {selectedProject && (
              <span title={selectedProject}>
                <GitBranch size={12} /> {projectName(selectedProject)}
              </span>
            )}
          </div>
          <div className="header-actions">
            <label className="model-select">
              <span className="model-select-icon" aria-hidden="true">
                <BrainCircuit size={15} strokeWidth={2.2} />
              </span>
              <select value={modelAlias} onChange={(event) => void setModel(event.target.value)}>
                {modelOptions.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </label>
            <button
              className={`header-button ${familiarEnabled ? "active" : ""}`}
              onClick={() => void toggleFamiliar()}
              title={familiarEnabled ? "Hide Magi Familiar" : "Show Magi Familiar"}
              aria-pressed={familiarEnabled}
            >
              <WandSparkles size={14} /> Familiar
            </button>
            <button
              className={`header-button ${terminalOpen ? "active" : ""}`}
              onClick={() => setTerminalOpen((value) => !value)}
            >
              <SquareTerminal size={14} /> Terminal
            </button>
            <button className="icon-button" onClick={() => void toggleRightPanel()}>
              {rightPanelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            </button>
          </div>
        </header>

        <div className="conversation-wrap">
          <div className="transcript" ref={transcriptRef}>
            {!status.connected && <OfflineState status={status} />}
            {status.connected && !selectedProject && <WelcomeState onOpen={chooseProject} />}
            {status.connected && selectedProject && !hasConversation && !loadingSession && (
              <NewTaskState project={selectedProject} />
            )}
            {loadingSession && (
              <div className="loading-session">
                <LoaderCircle size={18} className="spin" /> Loading task…
              </div>
            )}
            {messages.map((message) => (
              <MessageBubble message={message} key={message.id} />
            ))}
            {optimisticMessage &&
              !messages.some(
                (message) => message.role === "user" && message.content === optimisticMessage
              ) && <UserMessage content={optimisticMessage} />}
            {liveDraft && (activeJobId || liveDraft.text) && (
              <AssistantMessage content={liveDraft.text} streaming={Boolean(activeJobId)} />
            )}
            {interactions.map((interaction) => (
              <InteractionCard
                key={`${interaction.jobId}:${interaction.toolUseId}`}
                interaction={interaction}
                onApproval={resolveApproval}
                onAnswer={answerQuestion}
              />
            ))}
            {error && (
              <div className="inline-error">
                <AlertCircle size={16} />
                <span>{error}</span>
                <button onClick={() => setError(undefined)} aria-label="Dismiss error">
                  <X size={14} />
                </button>
              </div>
            )}
          </div>

          {status.connected && (
            <div className="composer-zone">
              <div className={`composer-card ${activeJobId ? "running" : ""}`}>
                <label className="composer-label" htmlFor="magi-composer">
                  Message Magi
                </label>
                {attachments.length > 0 && (
                  <div className="attachment-strip" aria-label="Attached images">
                    {attachments.map((attachment) => (
                      <div className="attachment-tile" key={attachment.id}>
                        <img
                          src={`data:${attachment.mimeType};base64,${attachment.data}`}
                          alt={attachment.name}
                        />
                        <span>
                          <strong>{attachment.name}</strong>
                          <small>{formatBytes(attachment.size)}</small>
                        </span>
                        <button
                          type="button"
                          onClick={() => removeImage(attachment.id)}
                          aria-label={`Remove ${attachment.name}`}
                          title="Remove image"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  id="magi-composer"
                  aria-label="Message Magi"
                  value={composer}
                  onChange={(event) => setComposer(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendPrompt();
                    }
                  }}
                  disabled={Boolean(activeJobId) || loadingSession}
                  placeholder={
                    loadingSession
                      ? "Loading task…"
                      : activeJobId
                        ? "Magi is working…"
                        : "Ask Magi to build, explain, or change something"
                  }
                  rows={1}
                />
                {attachments.length > 0 && (
                  <div
                    className={`attachment-capability ${selectedModelSupportsImages === false ? "warning" : ""}`}
                  >
                    <ImageIcon size={12} />
                    {modelAlias === "auto"
                      ? "Auto will choose a vision-capable model"
                      : selectedModelSupportsImages === false
                        ? "This model is not configured for image input. Choose a vision model."
                        : selectedModelSupportsImages === true
                          ? "Current model supports image input"
                          : "Magi will send images to the current model"}
                  </div>
                )}
                <div className="composer-toolbar">
                  <button
                    className="composer-tool"
                    type="button"
                    title="Attach images"
                    aria-label="Attach images"
                    onClick={() => void chooseImages()}
                    disabled={
                      Boolean(activeJobId) ||
                      loadingSession ||
                      attachments.length >= MAX_IMAGE_ATTACHMENTS
                    }
                  >
                    <Plus size={16} />
                  </button>
                  <div className="composer-permission" ref={permissionMenuRef}>
                    <button
                      className={`permission-trigger ${permissionMenuOpen ? "open" : ""}`}
                      type="button"
                      onClick={() => setPermissionMenuOpen((value) => !value)}
                      aria-haspopup="menu"
                      aria-expanded={permissionMenuOpen}
                      title="Choose permission mode"
                    >
                      <ShieldCheck size={16} />
                      <span>{permissionModeLabel(permissionMode)}</span>
                      <ChevronDown size={12} />
                    </button>
                    {permissionMenuOpen && (
                      <div className="permission-menu" role="menu" aria-label="Permission mode">
                        <div className="permission-menu-title">
                          <strong>任务权限</strong>
                          <span>应用到下一次任务</span>
                        </div>
                        {PERMISSION_OPTIONS.map((option) => {
                          const selected = option.value === permissionMode;
                          return (
                            <button
                              key={option.value}
                              className={`${selected ? "selected" : ""} ${option.caution ? "caution" : ""}`}
                              type="button"
                              role="menuitemradio"
                              aria-checked={selected}
                              onClick={() => {
                                setPermissionMenuOpen(false);
                                void updatePermissionMode(option.value);
                              }}
                            >
                              <span className="permission-menu-check">
                                {selected && <Check size={12} />}
                              </span>
                              <span>
                                <strong>{permissionModeLabel(option.value)}</strong>
                                <small>{option.description}</small>
                              </span>
                            </button>
                          );
                        })}
                        <button
                          className="permission-menu-settings"
                          type="button"
                          onClick={() => {
                            setPermissionMenuOpen(false);
                            setSettingsOpen(true);
                          }}
                        >
                          <Settings size={13} /> 打开权限设置
                        </button>
                      </div>
                    )}
                  </div>
                  <span className="composer-context">
                    {selectedProject ? compactPath(selectedProject, 48) : "Choose a project"}
                  </span>
                  {activeJobId ? (
                    <button
                      className="send-button stop"
                      onClick={() => void cancelJob()}
                      title="Stop task"
                    >
                      <CircleStop size={17} />
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      disabled={!canSendPrompt}
                      onClick={() => void sendPrompt()}
                      title="Send"
                    >
                      <ArrowUp size={17} />
                    </button>
                  )}
                </div>
              </div>
              <div className="composer-hint">Enter to send · Shift Enter for a new line</div>
            </div>
          )}

          {terminalOpen && (
            <div className="terminal-drawer">
              <div className="terminal-header">
                <span>
                  <SquareTerminal size={14} /> Terminal activity
                </span>
                <span className="terminal-project">{selectedProject ?? "No project"}</span>
                <button onClick={() => setTerminalOpen(false)} aria-label="Close terminal">
                  <X size={14} />
                </button>
              </div>
              <div className="terminal-body">
                {terminalEvents.length === 0 ? (
                  <span className="terminal-empty">
                    Agent commands and runner output will appear here.
                  </span>
                ) : (
                  terminalEvents.map((event) => (
                    <div className="terminal-line" key={event.id}>
                      <span
                        className={event.status === "failed" ? "terminal-fail" : "terminal-prompt"}
                      >
                        {event.status === "failed" ? "!" : "›"}
                      </span>
                      <code>
                        {event.target ? `${event.target}: ` : ""}
                        {event.message}
                      </code>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </main>

      {rightPanelOpen && (
        <aside className="inspector">
          <div className="inspector-tabs">
            <button
              className={rightTab === "activity" ? "active" : ""}
              onClick={() => setRightTab("activity")}
            >
              Activity
              {activeJobId && <span className="live-dot" />}
            </button>
            <button
              className={rightTab === "changes" ? "active" : ""}
              onClick={() => setRightTab("changes")}
            >
              Changes
              {changeEvents.length > 0 && <span className="tab-count">{changeEvents.length}</span>}
            </button>
          </div>
          <div className="inspector-content">
            {rightTab === "activity" ? (
              <ActivityPanel events={activityEvents} active={Boolean(activeJobId)} />
            ) : (
              <ChangesPanel events={changeEvents} />
            )}
          </div>
          <div className="inspector-footer">
            <span className={`connection-pill ${status.phase}`}>
              <span /> {status.phase === "ready" ? "Connected" : status.phase}
            </span>
            {selectedProject && (
              <span title={selectedProject}>{compactPath(selectedProject, 26)}</span>
            )}
          </div>
        </aside>
      )}

      {settingsOpen && (
        <SettingsDialog
          permissionMode={permissionMode}
          providers={bootstrap?.providers}
          onConfigureProvider={configureProvider}
          onPermissionMode={updatePermissionMode}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

const PERMISSION_OPTIONS: Array<{
  value: PermissionMode;
  title: string;
  description: string;
  caution?: boolean;
}> = [
  {
    value: "default",
    title: "Ask before changes",
    description: "Read-only work runs automatically. Magi asks before edits and commands."
  },
  {
    value: "acceptEdits",
    title: "Allow edits",
    description: "Ordinary file edits and commands run without an approval prompt."
  },
  {
    value: "plan",
    title: "Read-only plan",
    description: "Magi can inspect and explain, but cannot change files or run write tools."
  },
  {
    value: "dontAsk",
    title: "Deny when approval is needed",
    description: "Non-read-only tools are denied instead of pausing to ask."
  },
  {
    value: "bypassPermissions",
    title: "Full access",
    description: "Skip normal approval prompts. Use only in a project you trust.",
    caution: true
  }
];

function SettingsDialog({
  permissionMode,
  providers,
  onConfigureProvider,
  onPermissionMode,
  onClose
}: {
  permissionMode: PermissionMode;
  providers?: DesktopBootstrap["providers"];
  onConfigureProvider: (input: ConfigureProviderInput) => Promise<ConfigureProviderResult>;
  onPermissionMode: (value: PermissionMode) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [providerName, setProviderName] = useState("custom");
  const [providerProtocol, setProviderProtocol] = useState<ProviderProtocol>("openai");
  const [providerUrl, setProviderUrl] = useState("https://api.openai.com/v1");
  const [providerKey, setProviderKey] = useState("");
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState<string>();
  const [providerNotice, setProviderNotice] = useState<string>();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function connectProvider(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!providerUrl.trim() || !providerKey.trim() || providerBusy) return;
    setProviderBusy(true);
    setProviderError(undefined);
    setProviderNotice(undefined);
    try {
      const result = await onConfigureProvider({
        providerName: providerName.trim(),
        protocol: providerProtocol,
        baseUrl: providerUrl.trim(),
        apiKey: providerKey.trim()
      });
      const provider = result.catalog.providers.find(
        (candidate) => candidate.name === result.providerName
      );
      setProviderKey("");
      setProviderUrl(provider?.baseUrl ?? providerUrl.trim());
      setProviderNotice(
        `${provider?.name ?? result.providerName} connected · ${provider?.models.length ?? 0} models loaded · ${provider?.defaultModel ?? result.selectedModel} selected`
      );
    } catch (nextError) {
      setProviderError(errorMessage(nextError));
    } finally {
      setProviderBusy(false);
    }
  }

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div>
            <small>Magi settings</small>
            <h2 id="settings-title">Models & permissions</h2>
          </div>
          <button onClick={onClose} aria-label="Close settings" title="Close settings">
            <X size={16} />
          </button>
        </header>
        <section className="settings-section provider-settings">
          <div className="settings-section-title">
            <span className="settings-section-icon" aria-hidden="true">
              <BrainCircuit size={16} strokeWidth={2.15} />
            </span>
            <span>
              <strong>Model connections</strong>
              <small>
                Add OpenAI-compatible or Anthropic Messages endpoints and load their models.
              </small>
            </span>
          </div>
          <form className="provider-form" onSubmit={(event) => void connectProvider(event)}>
            <div className="provider-form-grid">
              <label>
                <span>Connection name</span>
                <input
                  value={providerName}
                  onChange={(event) => setProviderName(event.target.value)}
                  placeholder="team-anthropic"
                  pattern="[A-Za-z0-9_-]+"
                  title="Use letters, numbers, hyphens, or underscores"
                  autoComplete="off"
                  required
                />
              </label>
              <label>
                <span>Protocol</span>
                <select
                  value={providerProtocol}
                  onChange={(event) => {
                    const next = event.target.value as ProviderProtocol;
                    setProviderProtocol(next);
                    if (
                      providerUrl === "https://api.openai.com/v1" ||
                      providerUrl === "https://api.anthropic.com"
                    ) {
                      setProviderUrl(
                        next === "anthropic"
                          ? "https://api.anthropic.com"
                          : "https://api.openai.com/v1"
                      );
                    }
                  }}
                >
                  <option value="openai">OpenAI compatible</option>
                  <option value="anthropic">Anthropic Messages</option>
                </select>
              </label>
              <label>
                <span>Base URL</span>
                <input
                  type="url"
                  value={providerUrl}
                  onChange={(event) => setProviderUrl(event.target.value)}
                  placeholder={
                    providerProtocol === "anthropic"
                      ? "https://api.anthropic.com"
                      : "https://api.example.com/v1"
                  }
                  autoComplete="url"
                  required
                />
              </label>
              <label>
                <span>API key</span>
                <input
                  type="password"
                  value={providerKey}
                  onChange={(event) => setProviderKey(event.target.value)}
                  placeholder="Enter API key"
                  autoComplete="off"
                  required
                />
              </label>
            </div>
            <button
              type="submit"
              disabled={
                providerBusy || !providerName.trim() || !providerUrl.trim() || !providerKey.trim()
              }
            >
              {providerBusy ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
              {providerBusy ? "Loading models…" : "Connect & load models"}
            </button>
          </form>
          <p className="provider-security-note">
            The key stays in Magi's owner-only local credentials file and is never stored in task
            history.
          </p>
          {providerError && <div className="provider-result error">{providerError}</div>}
          {providerNotice && <div className="provider-result success">{providerNotice}</div>}
          {(providers?.providers ?? []).some((provider) => provider.models.length > 0) && (
            <div className="provider-connections" aria-label="Configured model connections">
              {(providers?.providers ?? [])
                .filter((provider) => provider.models.length > 0)
                .map((provider) => (
                  <button
                    type="button"
                    key={provider.name}
                    onClick={() => {
                      setProviderName(provider.name);
                      setProviderProtocol(provider.protocol);
                      setProviderUrl(provider.baseUrl ?? "");
                      setProviderNotice(undefined);
                    }}
                    title="Edit this connection"
                  >
                    <span>
                      <strong>{provider.name}</strong>
                      <small>{provider.protocol === "anthropic" ? "Anthropic" : "OpenAI"}</small>
                    </span>
                    <em>{provider.models.length} models</em>
                  </button>
                ))}
            </div>
          )}
        </section>
        <div className="settings-intro">
          <ShieldCheck size={18} />
          <p>
            Choose what Magi may do in new tasks. Pending tool requests still appear in the
            conversation with Allow and Deny controls.
          </p>
        </div>
        <div className="permission-options" role="radiogroup" aria-label="Permission mode">
          {PERMISSION_OPTIONS.map((option) => {
            const selected = option.value === permissionMode;
            return (
              <button
                key={option.value}
                className={`${selected ? "selected" : ""} ${option.caution ? "caution" : ""}`}
                role="radio"
                aria-checked={selected}
                onClick={() => void onPermissionMode(option.value)}
              >
                <span className="permission-radio">{selected && <Check size={12} />}</span>
                <span className="permission-copy">
                  <strong>{option.title}</strong>
                  <small>{option.description}</small>
                </span>
              </button>
            );
          })}
        </div>
        <footer className="settings-footer">
          <span>Changes apply to the next task you start.</span>
          <button onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  );
}

function WelcomeState({ onOpen }: { onOpen: () => Promise<void> }): React.JSX.Element {
  return (
    <div className="hero-state">
      <div className="hero-orbit">
        <img src="./magi-mark.svg" alt="" />
      </div>
      <h1>Build with a local agent</h1>
      <p>Open a project to give Magi a working directory, then start a task.</p>
      <button onClick={() => void onOpen()}>
        <FolderOpen size={16} /> Open project
      </button>
    </div>
  );
}

function NewTaskState({ project }: { project: string }): React.JSX.Element {
  return (
    <div className="new-task-state">
      <div className="new-task-icon">
        <WandSparkles size={22} />
      </div>
      <h1>What should we work on?</h1>
      <p>
        Magi can inspect <strong>{projectName(project)}</strong>, edit files, run commands, and ask
        before sensitive actions.
      </p>
      <div className="suggestion-grid">
        <span>Explain this codebase</span>
        <span>Find and fix a bug</span>
        <span>Build a new feature</span>
      </div>
    </div>
  );
}

function OfflineState({ status }: { status: ServiceStatus }): React.JSX.Element {
  return (
    <div className="hero-state offline-state">
      <div className="offline-icon">
        <XCircle size={24} />
      </div>
      <h1>Local agent is offline</h1>
      <p>{status.message ?? "Magi could not connect to the local headless service."}</p>
      <code>npm run build && node dist/cli.js daemon start</code>
    </div>
  );
}

function MessageBubble({ message }: { message: SessionMessage }): React.JSX.Element | null {
  if (message.role === "user") return <UserMessage content={message.content} />;
  if (message.role === "assistant") return <AssistantMessage content={message.content} />;
  return null;
}

function UserMessage({ content }: { content: string }): React.JSX.Element {
  const displayContent = content.replace(
    /\[image ([^\]]+)\]/g,
    (_match, mimeType: string) => `📎 Image attachment · ${mimeType}`
  );
  return (
    <article className="message user-message">
      <MarkdownMessage content={displayContent} />
    </article>
  );
}

function AssistantMessage({
  content,
  streaming = false
}: {
  content: string;
  streaming?: boolean;
}): React.JSX.Element {
  return (
    <article className="message assistant-message">
      <div className="assistant-glyph">
        <Sparkles size={15} />
      </div>
      <div className="assistant-content">
        {content ? <MarkdownMessage content={content} /> : <ThinkingIndicator />}
        {streaming && content && <span className="stream-caret" />}
      </div>
    </article>
  );
}

function ThinkingIndicator(): React.JSX.Element {
  return (
    <div className="thinking-indicator">
      <span /> <span /> <span />
      <em>Working</em>
    </div>
  );
}

function InteractionCard({
  interaction,
  onApproval,
  onAnswer
}: {
  interaction: ActiveInteraction;
  onApproval: (interaction: ActiveInteraction, approved: boolean) => Promise<void>;
  onAnswer: (interaction: ActiveInteraction, answer: UserQuestionAnswer) => Promise<void>;
}): React.JSX.Element {
  const [selections, setSelections] = useState<Record<number, string[]>>({});
  if (interaction.kind === "question") {
    const questions = interaction.question?.questions ?? [];
    const complete =
      questions.length > 0 && questions.every((_question, index) => selections[index]?.length > 0);

    function toggleSelection(index: number, label: string, multiSelect: boolean): void {
      setSelections((current) => {
        const selected = current[index] ?? [];
        return {
          ...current,
          [index]: multiSelect
            ? selected.includes(label)
              ? selected.filter((item) => item !== label)
              : [...selected, label]
            : [label]
        };
      });
    }

    return (
      <div className="interaction-card question-card">
        <div className="interaction-icon">
          <WandSparkles size={17} />
        </div>
        <div className="interaction-main">
          <small>Magi needs your input</small>
          {questions.map((question, questionIndex) => (
            <div className="question-item" key={`${questionIndex}:${question.question}`}>
              {question.header && <em>{question.header}</em>}
              <strong>{question.question}</strong>
              <div className="question-options">
                {(question.options ?? []).map((option) => {
                  const selected = selections[questionIndex]?.includes(option.label) ?? false;
                  return (
                    <button
                      className={selected ? "selected" : ""}
                      key={option.label}
                      onClick={() =>
                        toggleSelection(questionIndex, option.label, question.multiSelect === true)
                      }
                    >
                      <span>
                        {selected && <Check size={12} />} {option.label}
                      </span>
                      {option.description && <small>{option.description}</small>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="question-submit">
            <button
              disabled={!complete}
              onClick={() =>
                void onAnswer(interaction, {
                  answers: questions.map((question, index) => ({
                    question: question.question,
                    selectedLabels: selections[index] ?? []
                  }))
                })
              }
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="interaction-card approval-card">
      <div className="interaction-icon">
        <AlertCircle size={17} />
      </div>
      <div className="interaction-main">
        <small>Permission requested</small>
        <strong>Allow {interaction.toolName}?</strong>
        <p>{interaction.reason ?? "This tool needs approval before Magi can continue."}</p>
        <pre>{JSON.stringify(interaction.toolUse.input ?? {}, null, 2)}</pre>
        <div className="approval-actions">
          <button className="deny" onClick={() => void onApproval(interaction, false)}>
            Deny
          </button>
          <button className="approve" onClick={() => void onApproval(interaction, true)}>
            <Check size={14} /> Allow once
          </button>
        </div>
      </div>
    </div>
  );
}

function ActivityPanel({
  events,
  active
}: {
  events: MagiEvent[];
  active: boolean;
}): React.JSX.Element {
  if (events.length === 0) {
    return (
      <div className="inspector-empty">
        <Activity size={21} />
        <strong>No activity yet</strong>
        <span>Tool calls, approvals, and progress will show up here.</span>
      </div>
    );
  }
  return (
    <div className="activity-list">
      {active && (
        <div className="activity-running">
          <LoaderCircle size={14} className="spin" /> Magi is working
        </div>
      )}
      {events.map((event) => (
        <ActivityRow event={event} key={event.id} />
      ))}
    </div>
  );
}

function ActivityRow({ event }: { event: MagiEvent }): React.JSX.Element {
  const failed = event.status === "failed" || event.status === "denied";
  const running = event.status === "started" || event.status === "pending";
  return (
    <div className={`activity-row ${failed ? "failed" : ""}`}>
      <div className={`event-status ${running ? "running" : failed ? "failed" : "done"}`}>
        {running ? (
          <LoaderCircle size={13} className="spin" />
        ) : failed ? (
          <X size={12} />
        ) : (
          <Check size={11} />
        )}
      </div>
      <div className="event-copy">
        <strong>{friendlyEventName(event)}</strong>
        <span>{event.message}</span>
      </div>
      <time>{formatTime(event.createdAt)}</time>
    </div>
  );
}

function ChangesPanel({ events }: { events: MagiEvent[] }): React.JSX.Element {
  if (events.length === 0) {
    return (
      <div className="inspector-empty">
        <FileCode2 size={21} />
        <strong>No file changes</strong>
        <span>Edits made by the agent will be summarized here.</span>
      </div>
    );
  }
  return (
    <div className="changes-list">
      {events.map((event) => (
        <div className="change-row" key={event.id}>
          <FileCode2 size={15} />
          <div>
            <strong>{event.target ?? "Workspace change"}</strong>
            <span>{event.message}</span>
          </div>
          <ChevronRight size={13} />
        </div>
      ))}
    </div>
  );
}

function friendlyEventName(event: MagiEvent): string {
  const action = event.action ?? event.eventName ?? "";
  const category = event.category ?? "activity";
  if (event.target && event.category === "tool") return event.target;
  if (action === "agent.query.started") return "Started task";
  if (action === "agent.query.completed") return "Completed task";
  if (action === "agent.request.started") return "Contacted model";
  if (action.includes("approval")) return "Approval";
  if (action.includes("question")) return "Question";
  if (action.includes("usage")) return "Usage";
  return category.charAt(0).toUpperCase() + category.slice(1);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
