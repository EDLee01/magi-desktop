import {
  ArrowUp,
  ExternalLink,
  LoaderCircle,
  MessageCircleMore,
  Power,
  Sparkles,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  DesktopBootstrap,
  FamiliarWindowState,
  MagiEvent,
  ServiceStatus,
  SessionSummary
} from "../../shared/contracts";
import { MarkdownMessage } from "./MarkdownMessage";
import { eventDelta, isTerminalEvent, projectName } from "./state";

type FamiliarMood = "idle" | "thinking" | "working" | "approval" | "success" | "offline";

const INITIAL_WINDOW_STATE: FamiliarWindowState = {
  visible: true,
  expanded: false,
  hidden: false
};

export function Familiar(): React.JSX.Element {
  const [bootstrap, setBootstrap] = useState<DesktopBootstrap>();
  const [status, setStatus] = useState<ServiceStatus>({
    connected: false,
    phase: "connecting"
  });
  const [windowState, setWindowState] = useState(INITIAL_WINDOW_STATE);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [composer, setComposer] = useState("");
  const [mood, setMood] = useState<FamiliarMood>("idle");
  const [notice, setNotice] = useState("Ready when you are");
  const [activeJobId, setActiveJobId] = useState<string>();
  const [currentSessionId, setCurrentSessionId] = useState<string>();
  const [responseText, setResponseText] = useState("");
  const [sending, setSending] = useState(false);
  const successTimer = useRef<number | undefined>(undefined);
  const activeJobIdRef = useRef<string | undefined>(undefined);
  const currentSessionIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    document.documentElement.classList.add("familiar-mode");
    return () => document.documentElement.classList.remove("familiar-mode");
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const initial = await window.magiDesktop.bootstrap();
        if (cancelled) return;
        setBootstrap(initial);
        setStatus(initial.status);
        if (initial.status.connected) {
          setSessions(await window.magiDesktop.listSessions());
          await window.magiDesktop.subscribeEvents();
          setMood("idle");
        } else {
          setMood("offline");
          setNotice("Local agent is offline");
        }
      } catch (error) {
        if (cancelled) return;
        setMood("offline");
        setNotice(errorMessage(error));
      }
    })();

    const removeStatus = window.magiDesktop.onServiceStatus((nextStatus) => {
      setStatus(nextStatus);
      if (!nextStatus.connected) {
        setMood(nextStatus.phase === "connecting" ? "thinking" : "offline");
        setNotice(nextStatus.message ?? "Local agent is offline");
      } else {
        setMood((current) => (current === "offline" ? "idle" : current));
        setNotice((current) =>
          current === "Local agent is offline" ? "Ready when you are" : current
        );
      }
    });
    const removeWindowState = window.magiDesktop.onFamiliarState(setWindowState);
    const removeEvent = window.magiDesktop.onEvent((envelope) => handleEvent(envelope.data));

    return () => {
      cancelled = true;
      window.clearTimeout(successTimer.current);
      void window.magiDesktop.unsubscribeEvents();
      removeStatus();
      removeWindowState();
      removeEvent();
    };
  }, []);

  const project = useMemo(
    () =>
      bootstrap?.settings.selectedProject ??
      bootstrap?.settings.recentProjects[0] ??
      status.workspace ??
      sessions[0]?.cwd,
    [bootstrap?.settings.recentProjects, bootstrap?.settings.selectedProject, sessions, status.workspace]
  );

  function handleEvent(event: MagiEvent | undefined): void {
    if (!event) return;
    if (
      event.action === "agent.approval.pending" ||
      event.action === "agent.user_question.pending"
    ) {
      currentSessionIdRef.current = event.sessionId;
      setCurrentSessionId(event.sessionId);
      setMood("approval");
      setNotice(event.action.includes("question") ? "Magi has a question" : "Approval needed");
      void window.magiDesktop.setFamiliarExpanded(true).then(setWindowState);
      return;
    }
    if (event.action === "agent.text.delta") {
      if (!activeJobIdRef.current || event.jobId !== activeJobIdRef.current) return;
      const delta = eventDelta(event);
      if (delta) setResponseText((current) => `${current}${delta}`.slice(0, 12_000));
      setMood("thinking");
      setNotice("Writing a response…");
      return;
    }
    if (isTerminalEvent(event)) {
      if (!activeJobIdRef.current || event.jobId !== activeJobIdRef.current) return;
      activeJobIdRef.current = undefined;
      setActiveJobId(undefined);
      setSending(false);
      setMood(event.status === "failed" ? "offline" : "success");
      setNotice(event.status === "failed" ? event.message || "Task failed" : "Task complete!");
      window.clearTimeout(successTimer.current);
      if (event.status !== "failed") {
        void hydrateFinalResponse(event.sessionId);
        successTimer.current = window.setTimeout(() => {
          setMood("idle");
          setNotice("Ready when you are");
        }, 3_000);
      }
      return;
    }
    if (event.jobId && (event.status === "started" || event.status === "pending")) {
      if (!activeJobIdRef.current || event.jobId !== activeJobIdRef.current) return;
      setMood("working");
      setNotice(event.target ? `Using ${event.target}…` : "Working on it…");
    }
  }

  async function hydrateFinalResponse(sessionId: string): Promise<void> {
    try {
      const session = await window.magiDesktop.getSession(sessionId);
      const finalAnswer = [...session.messages]
        .reverse()
        .find((message) => message.role === "assistant" && message.content.trim());
      if (finalAnswer) setResponseText((current) => current || finalAnswer.content);
    } catch {}
  }

  async function toggleExpanded(): Promise<void> {
    const next = await window.magiDesktop.setFamiliarExpanded(!windowState.expanded);
    setWindowState(next);
  }

  async function sendPrompt(): Promise<void> {
    const prompt = composer.trim();
    if (!prompt || sending || activeJobId || !status.connected) return;
    if (!project) {
      setNotice("Open Magi and choose a project first");
      setMood("approval");
      return;
    }

    setSending(true);
    setResponseText("");
    setMood("thinking");
    setNotice("Casting your task…");
    try {
      let availableSessions = sessions;
      if (availableSessions.length === 0) {
        availableSessions = await window.magiDesktop.listSessions();
        setSessions(availableSessions);
      }
      const session = [...availableSessions]
        .filter((item) => item.cwd === project)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      let sessionId = session?.id;
      if (!session) {
        const created = await window.magiDesktop.createSession({
          cwd: project,
          title: prompt.slice(0, 64)
        });
        sessionId = created.id;
      }
      currentSessionIdRef.current = sessionId;
      setCurrentSessionId(sessionId);
      const result = await window.magiDesktop.startJob({
        sessionId: sessionId!,
        prompt,
        modelAlias: bootstrap?.settings.modelAlias ?? "main",
        permissionMode: bootstrap?.settings.permissionMode ?? "default",
        attachments: []
      });
      setComposer("");
      activeJobIdRef.current = result.jobId;
      setActiveJobId(result.jobId);
      setMood("working");
      setNotice("Magi is working…");
    } catch (error) {
      setMood("offline");
      setNotice(errorMessage(error));
      setSending(false);
    }
  }

  async function openMagi(): Promise<void> {
    await window.magiDesktop.openMainWindow(currentSessionIdRef.current ?? currentSessionId);
  }

  async function turnOff(): Promise<void> {
    await window.magiDesktop.setFamiliarVisible(false);
  }

  const busy = sending || Boolean(activeJobId);
  const showAttention = mood === "approval" || mood === "offline";

  return (
    <main
      className={`familiar-root familiar-${mood} ${windowState.expanded ? "expanded" : "collapsed"} ${windowState.edge ? `edge-${windowState.edge}` : ""}`}
      onPointerEnter={() => void window.magiDesktop.revealFamiliar().then(setWindowState)}
      onPointerLeave={() => {
        if (!windowState.expanded) void window.magiDesktop.scheduleFamiliarHide();
      }}
    >
      <div className="familiar-drag-handle" title="Drag Magi" aria-hidden="true">
        <span />
      </div>
      <div className="familiar-sparkles" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <img className="familiar-character" src="./magi-familiar.png" alt="Magi magic hat familiar" />
      <button
        className="familiar-face-button"
        type="button"
        onClick={() => void toggleExpanded()}
        aria-label={windowState.expanded ? "Close Magi composer" : "Message Magi"}
        title={windowState.expanded ? "Close" : "Message Magi"}
      />
      <div className={`familiar-status ${showAttention ? "attention" : ""}`}>
        {busy && <LoaderCircle size={12} className="spin" />}
        {!busy && mood === "success" && <Sparkles size={12} />}
        {!busy && mood === "approval" && <MessageCircleMore size={12} />}
        <span>{notice}</span>
      </div>

      {windowState.expanded && (
        <section className="familiar-panel" aria-label="Message Magi">
          <header>
            <span>
              <strong>Magi Familiar</strong>
              <small>{project ? projectName(project) : "No project selected"}</small>
            </span>
            <button type="button" onClick={() => void toggleExpanded()} aria-label="Close composer">
              <X size={14} />
            </button>
          </header>
          {responseText && (
            <div className={`familiar-response ${busy ? "streaming" : ""}`}>
              <MarkdownMessage content={responseText} />
            </div>
          )}
          <textarea
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendPrompt();
              }
            }}
            placeholder={
              status.connected
                ? responseText
                  ? "Ask a follow-up…"
                  : "Ask Magi to do something…"
                : "Local agent is offline"
            }
            disabled={!status.connected || busy}
            rows={2}
            autoFocus
          />
          <footer>
            <button className="familiar-open-button" type="button" onClick={() => void openMagi()}>
              <ExternalLink size={13} /> Open Magi
            </button>
            <button className="familiar-power-button" type="button" onClick={() => void turnOff()} title="Turn off Familiar">
              <Power size={13} />
            </button>
            <button
              className="familiar-send-button"
              type="button"
              onClick={() => void sendPrompt()}
              disabled={!composer.trim() || !status.connected || busy}
              aria-label="Send task"
            >
              {busy ? <LoaderCircle size={15} className="spin" /> : <ArrowUp size={15} />}
            </button>
          </footer>
        </section>
      )}
    </main>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
