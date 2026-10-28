import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, AgentStatus, SessionFile, SharedView } from '../types'

const PANE = 'agent-board'
const TITLE = 'Agents'
const KEEP = 50
const TICK_MS = 30_000
const COALESCE_MS = 2_000
const STALE_MS = 120_000
const SHOWN_FINISHED = 10
const GITHUB = 'https://api.github.com'

// Bump a shape tag whenever its type's fields change, so a value an older
// build stored (which outlives a reload) is declined rather than misread.
const agents = atom({ plugin: 'agent-board', key: 'agents' } as const, [], {
  shape: 'agents-1',
})
const shared = atom(
  { plugin: 'agent-board', key: 'shared' } as const,
  { fetchedAt: 0, sessions: [] } as SharedView,
  { shape: 'shared-1' },
)

type Options = { gistId: string; githubToken: string }

const short = (text: string, max: number) =>
  text.length > max ? text.slice(0, max - 1) + '…' : text

const elapsed = (from: number, to: number) => {
  const s = Math.max(0, Math.round((to - from) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const clockPT = (ms: number) => {
  try {
    return new Date(ms).toLocaleTimeString('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return new Date(ms).toISOString().slice(11, 16) + ' UTC'
  }
}

const basename = (path: string) => {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

const mark: Record<AgentStatus, string> = {
  running: '>',
  idle: '~',
  done: 'ok',
  failed: 'x',
  aborted: '-',
  killed: '-',
}

const tone = (status: AgentStatus): 'success' | 'error' | 'warning' | 'text' =>
  status === 'running'
    ? 'success'
    : status === 'failed'
      ? 'error'
      : status === 'aborted' || status === 'killed'
        ? 'warning'
        : 'text'

const isRunning = (a: AgentRow) => a.status === 'running'

const isSessionFile = (v: unknown): v is SessionFile =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as SessionFile).sessionId === 'string' &&
  typeof (v as SessionFile).updatedAt === 'number' &&
  Array.isArray((v as SessionFile).agents)

// Module-level: options and timers. A reload starts these over, and
// session.start runs again then and restarts the timer. Nothing drawn reads
// them: state does that.
type Self = { sessionId: string; host: string; cwd: string; startedAt: number }
const ctx: {
  gistId: string
  token: string
  isShared: boolean
  tick?: { cancel: () => void }
  flush?: { cancel: () => void }
  ticks: number
  me?: Self
} = { gistId: '', token: '', isShared: false, ticks: 0 }

async function who($: EngineInterface): Promise<Self> {
  if (ctx.me) return ctx.me
  const [sessionId, cwd, startedAt] = await Promise.all([
    $.session.id(),
    $.session.cwd(),
    $.clock.now(),
  ])
  const host =
    (await $.env.get('COMPUTERNAME')) ??
    (await $.env.get('HOSTNAME')) ??
    'cloud'
  ctx.me = { sessionId, host, cwd: basename(cwd), startedAt }
  return ctx.me
}

function gistInit(init?: { method?: string; body?: string }) {
  return {
    method: init?.method ?? 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${ctx.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init?.body ? { body: init.body } : {}),
  }
}

const gistUrl = () => `${GITHUB}/gists/${ctx.gistId}`

async function markFailed($: EngineInterface) {
  const now = await $.clock.now()
  await update($, shared, v => (v.failedSince ? v : { ...v, failedSince: now }))
}

// Writer: this session's file in the gist. Never throws; a failure is
// recorded on the shared view and retried on the next tick.
async function push($: EngineInterface) {
  if (!ctx.isShared) return
  try {
    const [self, list, now] = await Promise.all([who($), read($, agents), $.clock.now()])
    const file: SessionFile = { ...self, updatedAt: now, agents: list.slice(-KEEP) }
    const res = await $.http.fetch(
      gistUrl(),
      gistInit({
        method: 'PATCH',
        body: JSON.stringify({
          files: { [`${self.sessionId}.json`]: { content: JSON.stringify(file) } },
        }),
      }),
    )
    if (!res.ok) throw new Error(`gist write: HTTP ${res.status}`)
    await update($, shared, v => (v.failedSince ? { ...v, failedSince: undefined } : v))
  } catch {
    await markFailed($)
  }
}

function pushSoon($: EngineInterface) {
  if (!ctx.isShared || ctx.flush) return
  ctx.flush = $.clock.after(COALESCE_MS, () => {
    ctx.flush = undefined
    void push($)
  })
}

// Reader: every session's file, merged. Own file is left out: local rows
// are fresher than the copy in the gist.
async function pull($: EngineInterface) {
  if (!ctx.isShared) return
  try {
    const self = await who($)
    const res = await $.http.fetch(gistUrl(), gistInit())
    if (!res.ok) throw new Error(`gist read: HTTP ${res.status}`)
    const body = JSON.parse(res.text) as {
      files?: Record<string, { content?: string; truncated?: boolean }>
    }
    const sessions: SessionFile[] = []
    for (const [name, f] of Object.entries(body.files ?? {})) {
      if (!name.endsWith('.json') || !f.content) continue
      try {
        const parsed: unknown = JSON.parse(f.content)
        if (isSessionFile(parsed) && parsed.sessionId !== self.sessionId) {
          sessions.push(parsed)
        }
      } catch {
        // a file another version wrote, or a partial write: skipped
      }
    }
    const now = await $.clock.now()
    await update($, shared, () => ({ fetchedAt: now, sessions }))
  } catch {
    await markFailed($)
  }
}

async function paneIsPlaced($: EngineInterface) {
  const panes = await $.ui.panes()
  return panes.some(p => p.id === PANE && p.isPlaced)
}

async function counts($: EngineInterface) {
  const [list, view, now] = await Promise.all([read($, agents), read($, shared), $.clock.now()])
  const fresh = view.sessions.filter(s => now - s.updatedAt < STALE_MS)
  const running =
    list.filter(isRunning).length +
    fresh.reduce((n, s) => n + s.agents.filter(isRunning).length, 0)
  return { running, sessions: 1 + fresh.length }
}

async function statusLine($: EngineInterface) {
  const { running, sessions } = await counts($)
  $.ui.status(
    running === 0
      ? undefined
      : `${running} agent${running === 1 ? '' : 's'} running across ${sessions} session${sessions === 1 ? '' : 's'}`,
  )
}

async function onTick($: EngineInterface) {
  ctx.ticks += 1
  const list = await read($, agents)
  // Heartbeat: every tick while an agent runs, every other tick otherwise.
  if (list.some(isRunning) || ctx.ticks % 2 === 0) await push($)
  if (await paneIsPlaced($)) await pull($)
  await statusLine($)
}

async function deleteOwnFile($: EngineInterface) {
  if (!ctx.isShared) return
  try {
    const self = await who($)
    await $.http.fetch(
      gistUrl(),
      gistInit({
        method: 'PATCH',
        body: JSON.stringify({ files: { [`${self.sessionId}.json`]: null } }),
      }),
    )
  } catch {
    // the file goes stale instead; readers grey it out after STALE_MS
  }
}

export const register: Register = (on, options) => {
  const opts = options as Partial<Options>
  ctx.gistId = (opts.gistId ?? '').trim()
  ctx.token = (opts.githubToken ?? '').trim()
  ctx.isShared = ctx.gistId !== '' && ctx.token !== ''
  ctx.tick?.cancel()
  ctx.flush?.cancel()
  ctx.tick = undefined
  ctx.flush = undefined
  ctx.ticks = 0
  ctx.me = undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-board',
      description: 'Open the Agents pane: what each subagent is working on, here and in other sessions',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    ctx.tick?.cancel()
    ctx.ticks = 0
    if (ctx.isShared) {
      ctx.tick = $.clock.every(TICK_MS, () => void onTick($))
      await pull($)
      await statusLine($)
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    ctx.tick?.cancel()
    ctx.flush?.cancel()
    await deleteOwnFile($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'agent-board' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await pull($)
    const { running, sessions } = await counts($)
    const mode = ctx.isShared
      ? `${sessions} session${sessions === 1 ? '' : 's'}`
      : 'this session only (no gist configured)'

    return { text: `Agents pane opened: ${running} running across ${mode}.` }
  }).catch(() => ({ text: 'Agents pane: could not read the board.' }))

  // A spawn resolves once the subagent started; its id is on the result.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId === undefined) return started
    const now = await $.clock.now()
    const row: AgentRow = {
      id: started.agentId,
      type: e.subagentType,
      description: e.description,
      status: 'running',
      startedAt: now,
      toolCount: 0,
    }
    await update($, agents, list =>
      [...list.filter(a => a.id !== row.id), row].slice(-KEEP),
    )
    pushSoon($)
    void statusLine($)

    return started
  }).catch(($, e, next) => next(e))

  // Every tool call inside a subagent's loop carries that loop's agentId.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const id = e.agentId
    const tool = e.tool
    await update($, agents, list =>
      list.map(a =>
        a.id === id ? { ...a, lastTool: tool, toolCount: a.toolCount + 1 } : a,
      ),
    )
    pushSoon($)

    return next(e)
  }).catch(($, e, next) => next(e))

  // The end of a subagent's run, with its report.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const id = e.agentId
    const now = await $.clock.now()
    const status: AgentStatus =
      e.reason === 'answer'
        ? 'done'
        : e.reason === 'aborted'
          ? 'aborted'
          : 'failed'
    const answer = short(e.answer.replace(/\s+/g, ' ').trim(), 160)
    await update($, agents, list =>
      list.map(a =>
        a.id === id ? { ...a, status, endedAt: now, answer } : a,
      ),
    )
    pushSoon($)
    void statusLine($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const [list, view, now] = await Promise.all([
      read($, agents),
      read($, shared),
      $.clock.now(),
    ])
    const cols = Math.max(24, e.viewport?.columns ?? 60)

    const row = (a: AgentRow) => {
      const until = a.endedAt ?? now
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text color={tone(a.status)} weight="bold">
              {mark[a.status]}{' '}
            </Text>
            <Text weight="semibold">
              {short(a.description || '(no description)', cols - 12)}
            </Text>
          </Text>
          <Text dimColor>
            {'  '}
            {a.type} · {elapsed(a.startedAt, until)} · {a.toolCount} tool
            {a.toolCount === 1 ? '' : 's'}
            {a.lastTool ? ` · last: ${a.lastTool}` : ''}
          </Text>
          {a.status !== 'running' && a.answer ? (
            <Text dimColor>
              {'  '}
              {short(a.answer, cols - 4)}
            </Text>
          ) : null}
        </Box>
      )
    }

    const section = (
      label: string,
      rows: AgentRow[],
      isStale = false,
    ) => {
      const running = rows.filter(isRunning)
      const finished = rows.filter(a => !isRunning(a)).reverse()
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="bold" dimColor={isStale}>
            {label}
            {isStale ? ' · stale' : ''}
          </Text>
          {rows.length === 0 && <Text dimColor>No agents spawned yet.</Text>}
          {running.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>Working now</Text>
              {running.map(row)}
            </Box>
          )}
          {finished.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>Finished</Text>
              {finished.slice(0, SHOWN_FINISHED).map(row)}
            </Box>
          )}
        </Box>
      )
    }

    const others = [...view.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
    const fresh = others.filter(s => now - s.updatedAt < STALE_MS)
    const runningHere = list.filter(isRunning).length
    const runningThere = fresh.reduce(
      (n, s) => n + s.agents.filter(isRunning).length,
      0,
    )

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {runningHere + runningThere} running · {1 + fresh.length} session
          {fresh.length === 0 ? '' : 's'}
          {ctx.isShared ? '' : ' · this session only'}
        </Text>
        {view.failedSince !== undefined && (
          <Text color="warning">
            Shared view unavailable since {clockPT(view.failedSince)} PT; showing this session
            {view.fetchedAt ? ' and the last copy of the others' : ''}.
          </Text>
        )}
        {section('This session', list)}
        {others.map(s =>
          section(
            `${s.cwd} on ${s.host}`,
            s.agents,
            now - s.updatedAt >= STALE_MS,
          ),
        )}
      </Box>
    )
  })
}
