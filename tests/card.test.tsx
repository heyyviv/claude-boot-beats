import { expect, test } from 'claude-code/testing'

const CARD = {
  plugin: 'startup-song',
  component: 'Pane',
  requestId: 'startup-card',
  surface: 'terminal',
  props: {
    title: 'today',
    isFocused: false,
    bodyColumns: 120,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

test('the card shows the streak, the repo and an event from this day', async ($, on) => {
  on('command.register', () => ({ value: { command: 'today' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: e.key === 'streak' ? { last: '2000-01-01', days: 5 } : undefined }))
  on('store.set', () => ({ value: undefined }))
  on('process.run', (_, e) => ({
    value: e.argv.includes('status')
      ? { exitCode: 0, stdout: '# branch.head main\n# branch.ab +1 -0\n1 .M N... a\n', stderr: '' }
      : { exitCode: 0, stdout: 'b3a1e95\u0000Fix the toast\u00002 hours ago\n', stderr: '' },
  }))
  on('http.fetch', (_, e) => ({
    value: e.url.includes('onthisday')
      ? {
          ok: true,
          status: 200,
          text: JSON.stringify({ selected: [{ year: 1969, text: 'The first ARPANET message is sent.' }] }),
        }
      : { ok: false, status: 500, text: '' },
  }))

  on('clock.after', () => ({ value: undefined }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await new Promise(resolve => setTimeout(resolve, 50))

  // Side by side when wide, stacked when narrow.
  for (const bodyColumns of [120, 50]) {
    const ui = await $.ui.mount({ ...CARD, props: { ...CARD.props, bodyColumns } })
    expect((await ui.find({ type: 'Text', text: /day streak/ }))?.text).toBe('✦ 1-day streak')
    expect((await ui.find({ type: 'Text', text: /main/ }))?.text).toContain('1 changed')
    expect((await ui.find({ type: 'Text', text: /Fix the toast/ }))?.text).toBe('Fix the toast')
    expect((await ui.find({ type: 'Text', text: /ON THIS DAY/ }))?.text).toBe('↺ ON THIS DAY · 1969')
    expect((await ui.find({ type: 'Text', text: /ARPANET/ }))?.text).toBe('The first ARPANET message is sent.')
    await ui.unmount()
  }
})

test('the card closes once the song has played', async ($, on) => {
  const closed: string[] = []
  on('command.register', () => ({ value: { command: 'today' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', (_, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repo' } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('audio.play', () => ({ value: undefined }))
  on('http.fetch', (_, e) => ({
    value: e.url.includes('itunes')
      ? {
          ok: true,
          status: 200,
          text: JSON.stringify({
            results: [{ trackName: 'luther', artistName: 'Kendrick Lamar', previewUrl: 'https://x/a.m4a' }],
          }),
        }
      : { ok: false, status: 500, text: '' },
  }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await new Promise(resolve => setTimeout(resolve, 50))

  expect(closed).toContain('startup-card')
})
