export type AgentStatus =
  | 'running'
  | 'done'
  | 'failed'
  | 'aborted'
  | 'idle'
  | 'killed'

export type AgentRow = {
  id: string
  type: string
  description: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  lastTool?: string
  toolCount: number
  answer?: string
}

/** One session's file in the shared gist: `<sessionId>.json`. */
export type SessionFile = {
  sessionId: string
  /** Hostname, or "cloud" when the session runs in a container. */
  host: string
  /** The working directory's last path segment. */
  cwd: string
  startedAt: number
  updatedAt: number
  agents: AgentRow[]
}

/** What the reader last merged from the gist. */
export type SharedView = {
  /** When the last successful pull finished; 0 when none has. */
  fetchedAt: number
  sessions: SessionFile[]
  /** Set while the gist is unreachable: when it first failed. */
  failedSince?: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-board': {
      agents: Shaped<AgentRow[]>
      shared: Shaped<SharedView>
    }
  }
}
