import type { EngineInterface, Register } from 'claude-code'

const SEARCH = 'https://itunes.apple.com/search'
const TOP = 10

type Track = { trackName?: string; artistName?: string; previewUrl?: string }

// Rotate through the genres across sessions, then play a random pick from the top results.
async function playSong($: EngineInterface, genres: string[], seconds: number) {
  const turn = Number((await $.store.get('nextGenre')) ?? 0)
  const genre = genres[turn % genres.length] ?? 'pop'
  await $.store.set('nextGenre', (turn + 1) % genres.length)

  const query = new URLSearchParams({ term: genre, media: 'music', entity: 'song', limit: String(TOP) })
  const res = await $.http.fetch(`${SEARCH}?${query}`)
  if (!res.ok) return

  const tracks = (JSON.parse(res.text).results as Track[]).filter(track => track.previewUrl)
  const track = tracks[Math.floor(Math.random() * tracks.length)]
  if (!track?.previewUrl) return

  $.ui.toast(`🎵 ${genre}: ${track.trackName} — ${track.artistName}`, { timeoutMs: seconds * 1000 })
  const stop = new AbortController()
  $.clock.after(seconds * 1000, () => stop.abort())
  await $.audio.play({ url: track.previewUrl }, { signal: stop.signal })
}

export const register: Register = (on, options) => {
  const genres = String(options.genres ?? '')
    .split(',')
    .map(genre => genre.trim())
    .filter(Boolean)
  const seconds = Math.min(30, Math.max(1, Number(options.seconds ?? 10)))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (e.isInteractive && genres.length > 0) {
      playSong($, genres, seconds).catch(() => {})
    }
    return started
  })
}
