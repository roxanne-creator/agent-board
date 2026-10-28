import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'agent-board',
  component: 'Pane',
  requestId: 'agent-board',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const T0 = 1_700_000_000_000
const TOKEN = 'github_pat_TESTTOKEN_notreal'
const OPTIONS = { options: { gistId: 'abc123', githubToken: TOKEN } }

type Fetch = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }

const boot = (on: On, now = T0) => {
  const clock = mock.clock(on, { now })
  mock.env(on, { HOSTNAME: 'my-pc' })
  on('command.register', () => ({ value: { command: 'agent-board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({
    value: [{ id: 'agent-board', title: 'Agents', isShown: true, isFocused: false, isPlaced: true }],
  }))
  on('session.id', () => ({ value: 'sess-me' }))
  on('session.cwd', () => ({ value: '/home/rox/my-project' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'sess-me' }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return clock
}

const spawnOf = (description: string, subagentType: string) => ({
  tool_use_id: 'tu-1',
  prompt: 'Do the task',
  description,
  subagentType,
  provider: { plugin: 'engine', tier: 'core' } as const,
  parentModel: 'sonnet',
  background: false,
  fork: false,
})

const gistWith = (files: Record<string, unknown>) =>
  JSON.stringify({
    files: Object.fromEntries(
      Object.entries(files).map(([name, content]) => [
        name,
        { content: typeof content === 'string' ? content : JSON.stringify(content) },
      ]),
    ),
  })

const otherSession = (sessionId: string, updatedAt: number, status: 'running' | 'done') => ({
  sessionId,
  host: 'cloud',
  cwd: 'client-site',
  startedAt: updatedAt - 60_000,
  updatedAt,
  agents: [
    {
      id: `${sessionId}-a`,
      type: 'general-purpose',
      description: `Audit forms for ${sessionId}`,
      status,
      startedAt: updatedAt - 30_000,
      toolCount: 4,
      lastTool: 'Bash',
    },
  ],
})

test('with no gist configured the pane works single-session on every surface', async ($, on) => {
  boot(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /this session only/ }))?.text).toBe(
      '0 running · 1 session · this session only',
    )
    expect(await ui.find({ type: 'Text', text: /No agents spawned yet/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('a spawned agent shows as working, then as finished, and is pushed to the gist', OPTIONS, async ($, on) => {
  const clock = boot(on)
  const fetches: Fetch[] = []
  on('http.fetch', (_, e) => {
    fetches.push(e)
    return { value: { status: 200, ok: true, headers: {}, text: gistWith({}) } }
  })
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'a1' }))
  const statuses: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  await $.agent.spawn(spawnOf('Scan form logs', 'Explore'))
  await $.tool.call({ tool: 'Grep', pattern: 'error', agentId: 'a1' })
  await $.tool.call({ tool: 'Read', file_path: '/x', agentId: 'a1' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^1 running/ }))?.text).toBe('1 running · 1 session')
    expect(await ui.find({ type: 'Text', text: /Scan form logs/ })).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /Explore/ }))?.text).toMatch(
      /Explore · \d+s · 2 tools · last: Read/,
    )
    await ui.unmount()
  }

  // The coalesced write lands 2 seconds after the last change.
  await clock.advance(2_500)
  const writes = fetches.filter(f => f.init?.method === 'PATCH')
  expect(writes.length).toBe(1)
  expect(writes[0]?.url).toBe('https://api.github.com/gists/abc123')
  expect(writes[0]?.init?.headers?.Authorization).toBe(`Bearer ${TOKEN}`)
  const body = JSON.parse(writes[0]?.init?.body ?? '{}') as {
    files: Record<string, { content: string }>
  }
  const file = JSON.parse(body.files['sess-me.json']?.content ?? '{}') as {
    host: string
    cwd: string
    agents: { description: string; toolCount: number }[]
  }
  expect(file.host).toBe('my-pc')
  expect(file.cwd).toBe('my-project')
  expect(file.agents[0]?.description).toBe('Scan form logs')
  expect(file.agents[0]?.toolCount).toBe(2)

  await $.turn.complete({
    agentId: 'a1',
    turnId: 't1',
    answer: 'Three failures found, all cache related.',
    reason: 'answer',
    durationMs: 1200,
    isAborted: false,
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^0 running/ }))?.text).toBe('0 running · 1 session')
  expect(await ui.find({ type: 'Text', text: /Three failures/ })).toBeTruthy()
  await ui.unmount()

  // The token never reaches a status line.
  expect(statuses.some(s => s?.includes(TOKEN))).toBe(false)
  expect(statuses).toContain('1 agent running across 1 session')
})

test('other sessions are merged from the gist and a dead one shows as stale', OPTIONS, async ($, on) => {
  const clock = boot(on)
  on('http.fetch', () => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: gistWith({
        'README.md': 'agent-board shared store',
        'sess-live.json': otherSession('sess-live', T0 - 20_000, 'running'),
        'sess-dead.json': otherSession('sess-dead', T0 - 10 * 60_000, 'running'),
        'sess-me.json': otherSession('sess-me', T0, 'running'),
        'garbage.json': '{not json',
      }),
    },
  }))
  const statuses: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // The live other session counts; the stale one and the gist's copy of
    // this session do not.
    expect((await ui.find({ type: 'Text', text: /^1 running/ }))?.text).toBe('1 running · 2 sessions')
    expect((await ui.find({ type: 'Text', text: /client-site on cloud · stale/ }))?.text).toBe(
      'client-site on cloud · stale',
    )
    expect(await ui.find({ type: 'Text', text: /Audit forms for sess-live/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Audit forms for sess-dead/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /unavailable/ })).toBeFalsy()
    await ui.unmount()
  }
  expect(statuses).toContain('1 agent running across 2 sessions')
})

test('when the gist is unreachable the pane keeps local rows and says so', OPTIONS, async ($, on) => {
  const clock = boot(on)
  let calls = 0
  on('http.fetch', () => {
    calls += 1
    return { value: { status: 503, ok: false, headers: {}, text: 'down' } }
  })
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'a1' }))
  on('ui.status', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await $.agent.spawn(spawnOf('Local work', 'fork'))
  await clock.advance(2_500)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Local work/ })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /unavailable/ }))?.text).toMatch(
    /^Shared view unavailable since \d{2}:\d{2} (AM|PM) PT; showing this session\.$/,
  )
  await ui.unmount()

  // One tick: at most one write and one read; no retry loop.
  const before = calls
  await clock.advance(30_000)
  expect(calls - before).toBeLessThanOrEqual(2)
})

test('session end deletes this session\'s file from the gist', OPTIONS, async ($, on) => {
  const clock = boot(on)
  const fetches: Fetch[] = []
  on('http.fetch', (_, e) => {
    fetches.push(e)
    return { value: { status: 200, ok: true, headers: {}, text: gistWith({}) } }
  })
  on('ui.status', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await $.session.end({ reason: 'other', sessionId: 'sess-me', resume: { id: 'sess-me' } })
  const last = fetches[fetches.length - 1]
  expect(last?.init?.method).toBe('PATCH')
  expect(JSON.parse(last?.init?.body ?? '{}')).toEqual({ files: { 'sess-me.json': null } })
})

test('a value an earlier build stored is declined', async ($, on) => {
  boot(on)
  on('state.get', () => ({
    value: { value: [{ id: 'old', type: 'x' }], version: 1 },
  }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No agents spawned yet/ })).toBeTruthy()
  await ui.unmount()
})
