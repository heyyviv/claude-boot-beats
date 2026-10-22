import type { EngineInterface, Register } from 'claude-code'

const SEARCH = 'https://itunes.apple.com/search'
const ON_THIS_DAY = 'https://en.wikipedia.org/api/rest_v1/feed/onthisday/selected'
const TOP = 10
const PANE = 'startup-card'
const BAR = 16
const FILES = 8
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// A startup card is no place for the day's tragedies.
const GRIM = /\b(kill|killed|killing|dead|death|died|shot|shooting|bomb|bombing|massacre|attack|murder|crash|executed|war)\b/i

type Track = { trackName?: string; artistName?: string; previewUrl?: string }
type Page = { titles?: { normalized?: string }; description?: string; extract?: string }
type Event = { year?: number; text?: string; pages?: Page[] }
type Change = { status: string; path: string }
type Commit = { hash: string; subject: string; when: string }
type Streak = { last: string; days: number }

// What the card shows. Each part fills in as it loads and redraws the pane.
let playing:
  | { genre: string; title: string; artist: string; seconds: number; elapsed: number; stop: AbortController }
  | undefined
let streak = 0
let repo: { branch: string; ahead: number; behind: number; changes: Change[]; commits: Commit[] } | undefined
let onThisDay: { year: number; text: string; title?: string; description?: string; extract?: string } | undefined

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
const day = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

// Days in a row Claude Code was started: today counts once, a missed day starts over.
async function bumpStreak($: EngineInterface) {
  const now = new Date()
  const today = day(now)
  const yesterday = day(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const saved = (await $.store.get('streak')) as Streak | undefined
  const days = saved?.last === today ? saved.days : saved?.last === yesterday ? saved.days + 1 : 1
  await $.store.set('streak', { last: today, days })
  streak = days
}

// One line of `git status --porcelain=v2`: ordinary (1), renamed (2), unmerged (u) or untracked (?).
function change(line: string): Change {
  const fields = line.split(' ')
  const kind = fields[0]
  if (kind === '?') return { status: '?', path: fields.slice(1).join(' ') }
  if (kind === 'u') return { status: 'U', path: fields.slice(10).join(' ') }

  const [staged = '.', unstaged = '.'] = fields[1] ?? ''
  const path = fields.slice(kind === '2' ? 9 : 8).join(' ').split('\t')[0] ?? ''
  return { status: staged !== '.' ? staged : unstaged, path }
}

function commit(line: string): Commit {
  const [hash = '', subject = '', when = ''] = line.split('\0')
  return { hash, subject, when: when.replace(/ ago$/, '') }
}

async function loadRepo($: EngineInterface, cwd: string) {
  const [status, log] = await Promise.all([
    $.process.run(['git', 'status', '--porcelain=v2', '--branch'], { cwd, timeoutMs: 5000 }),
    $.process.run(['git', 'log', '-5', '--format=%h%x00%s%x00%cr'], { cwd, timeoutMs: 5000 }),
  ])
  if (status.exitCode !== 0) return

  const lines = status.stdout.split('\n').filter(Boolean)
  const header = (name: string) => lines.find(line => line.startsWith(`# branch.${name} `))?.split(' ').slice(2)
  const [ahead, behind] = header('ab') ?? []
  repo = {
    branch: header('head')?.[0] ?? '?',
    ahead: Math.abs(Number(ahead ?? 0)),
    behind: Math.abs(Number(behind ?? 0)),
    changes: lines.filter(line => !line.startsWith('#')).map(change),
    commits: log.exitCode === 0 ? log.stdout.split('\n').filter(Boolean).map(commit) : [],
  }
  $.ui.invalidate('ui.render')
}

async function loadOnThisDay($: EngineInterface) {
  const now = new Date()
  const date = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`
  const res = await $.http.fetch(`${ON_THIS_DAY}/${date}`)
  if (!res.ok) return

  const events = ((JSON.parse(res.text).selected ?? []) as Event[]).filter(event => event.year && event.text)
  const pleasant = events.filter(event => !GRIM.test(event.text ?? ''))
  const pool = pleasant.length > 0 ? pleasant : events
  const event = pool[Math.floor(Math.random() * pool.length)]
  if (!event?.year || !event.text) return

  const page = event.pages?.[0]
  onThisDay = {
    year: event.year,
    text: event.text,
    title: page?.titles?.normalized,
    description: page?.description,
    extract: page?.extract,
  }
  $.ui.invalidate('ui.render')
}

// Rotate through the genres across sessions, then play a random pick from the top results.
// Resolves true once a song has played (to the end or stopped), false when none could.
async function playSong($: EngineInterface, genres: string[], seconds: number) {
  const turn = Number((await $.store.get('nextGenre')) ?? 0)
  const genre = genres[turn % genres.length] ?? 'pop'
  await $.store.set('nextGenre', (turn + 1) % genres.length)

  const query = new URLSearchParams({ term: genre, media: 'music', entity: 'song', limit: String(TOP) })
  const res = await $.http.fetch(`${SEARCH}?${query}`)
  if (!res.ok) return false

  const tracks = (JSON.parse(res.text).results as Track[]).filter(track => track.previewUrl)
  const track = tracks[Math.floor(Math.random() * tracks.length)]
  if (!track?.previewUrl) return false

  const stop = new AbortController()
  playing = {
    genre,
    title: track.trackName ?? 'Unknown track',
    artist: track.artistName ?? 'Unknown artist',
    seconds,
    elapsed: 0,
    stop,
  }

  const tick = $.clock.every(1000, () => {
    if (playing) playing.elapsed = Math.min(seconds, playing.elapsed + 1)
    $.ui.invalidate('ui.render')
  })
  $.clock.after(seconds * 1000, () => stop.abort())
  try {
    await $.audio.play({ url: track.previewUrl }, { signal: stop.signal })
  } finally {
    tick.cancel()
    playing = undefined
    $.ui.invalidate('ui.render')
  }
  return true
}

// Esc at the prompt closes the card, and closing it stops the song.
async function openCard($: EngineInterface) {
  const now = new Date()
  const title = `${DAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]}`
  return $.ui.open({ id: PANE, title, closeOnEscape: true, rows: 16 })
}

export const register: Register = (on, options) => {
  const genres = String(options.genres ?? '')
    .split(',')
    .map(genre => genre.trim())
    .filter(Boolean)
  const seconds = Math.min(30, Math.max(1, Number(options.seconds ?? 10)))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'today', description: 'Show the startup card: streak, repo, on this day' })
    if (!e.isInteractive) return started

    // Each part loads on its own, so one failing leaves the rest of the card.
    bumpStreak($)
      .then(() => $.ui.invalidate('ui.render'))
      .catch(() => {})
    openCard($).catch(() => {})
    loadRepo($, e.cwd).catch(() => {})
    loadOnThisDay($).catch(() => {})
    // The card leaves with the song: when it ends, or after its length if none could play.
    const close = () => $.ui.close({ id: PANE }).catch(() => {})
    if (genres.length > 0) {
      playSong($, genres, seconds)
        .catch(() => false)
        .then(played => {
          if (played) close()
          else $.clock.after(seconds * 1000, close)
        })
    } else {
      $.clock.after(seconds * 1000, close)
    }
    return started
  })

  on('command.run', { command: 'today' }, async $ => {
    await openCard($)
    return { text: 'Startup card opened. Esc closes it.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    playing?.stop.abort()
    return next(e)
  })

  // ♪ Track · Artist                     ━━━━━━━━──────── 0:04 / 0:10
  // ✦ 12-day streak                                          esc stop
  //
  // ⎇ main  ↑1                    ↺ ON THIS DAY · 1969
  //  M hooks/register.tsx           The first message is sent over ARPANET.
  //  ? tests/                       ARPANET — early packet-switching network
  // b3a1e95 Point install…  1 day    The Advanced Research Projects Agency...
  // (side by side when there's room, stacked when not)
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const wide = e.props.bodyColumns >= 100
    const half = Math.floor((e.props.bodyColumns - 4) / 2)
    const filled = playing ? Math.round((playing.elapsed / playing.seconds) * BAR) : 0
    const heading = (text: string) => (
      <Text bold color="subtle">
        {text}
      </Text>
    )

    const git = repo ? (
      <Box flexDirection="column">
        <Text>
          <Text bold color="suggestion">
            ⎇ {repo.branch}
          </Text>
          <Text dimColor>
            {repo.ahead > 0 ? `  ↑${repo.ahead}` : ''}
            {repo.behind > 0 ? `  ↓${repo.behind}` : ''}
            {repo.changes.length === 0 ? '  clean' : `  ${repo.changes.length} changed`}
          </Text>
        </Text>
        {repo.changes.slice(0, FILES).map(file => (
          <Text wrap="truncate-middle">
            <Text color={file.status === 'D' ? 'error' : file.status === '?' ? 'warning' : 'success'}>
              {' '}
              {file.status}{' '}
            </Text>
            {file.path}
          </Text>
        ))}
        {repo.changes.length > FILES && <Text dimColor> +{repo.changes.length - FILES} more</Text>}
        {repo.commits.length > 0 && <Text> </Text>}
        {repo.commits.length > 0 && heading('RECENT COMMITS')}
        {repo.commits.map(one => (
          <Box flexDirection="row" gap={1}>
            <Text color="claude">{one.hash}</Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">{one.subject}</Text>
            </Box>
            <Text dimColor>{one.when}</Text>
          </Box>
        ))}
      </Box>
    ) : (
      <Text dimColor>⎇ not a git repo</Text>
    )

    const history = onThisDay && (
      <Box flexDirection="column">
        {heading(`↺ ON THIS DAY · ${onThisDay.year}`)}
        <Text wrap="wrap">{onThisDay.text}</Text>
        {onThisDay.title && <Text> </Text>}
        {onThisDay.title && (
          <Text wrap="wrap">
            <Text bold>{onThisDay.title}</Text>
            {onThisDay.description && <Text dimColor> — {onThisDay.description}</Text>}
          </Text>
        )}
        {onThisDay.extract && (
          <Text wrap="wrap" dimColor>
            {onThisDay.extract}
          </Text>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {playing && (
          <Box flexDirection="row" gap={2}>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">
                <Text color="claude">♪ </Text>
                <Text bold>{playing.title}</Text>
                <Text dimColor> · {playing.artist}</Text>
              </Text>
            </Box>
            <Text>
              <Text color="claude">{'━'.repeat(filled)}</Text>
              <Text color="subtle">{'─'.repeat(BAR - filled)}</Text>
              <Text dimColor>
                {' '}
                {clock(playing.elapsed)} / {clock(playing.seconds)}
              </Text>
            </Text>
          </Box>
        )}
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            <Text color="warning">✦ </Text>
            <Text bold>{streak}</Text>
            <Text dimColor>-day streak</Text>
          </Text>
          <Text dimColor>
            <Text bold>esc</Text> {playing ? 'stop' : 'close'}
          </Text>
        </Box>
        <Text> </Text>
        {wide ? (
          <Box flexDirection="row" gap={4}>
            <Box width={half} flexDirection="column">
              {git}
            </Box>
            <Box width={half} flexDirection="column">
              {history}
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column" gap={1}>
            {git}
            {history}
          </Box>
        )}
      </Box>
    )
  })
}
