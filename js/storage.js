/**
 * Where the app's data lives.
 *
 * localStorage, not IndexedDB. The whole point of this app is that starting is
 * hard, so every part of it should be simple enough to stay working: one JSON
 * document, read once at boot, written after each change. A session record is
 * roughly 150 bytes, so a few starts a day stays small for years, and IndexedDB
 * would buy asynchronous writes and more room without either being the binding
 * constraint at this size. When the synchronous write starts being felt, move
 * it — `load` / `save` are the only two functions that would change, and nothing
 * above this file knows which store is underneath.
 *
 * What the choice does *not* buy is durability. Browsers and phone operating
 * systems reclaim site storage, and IndexedDB is reclaimed by the same
 * mechanisms — so "we are under the quota" is not a reason to feel safe, and no
 * store available here would make it one. Guarding against loss means being able
 * to export, which does not exist yet. See README.
 *
 * Two things this file has to get right, because both fail silently otherwise:
 *
 *   - a version on the document, so a later shape change can migrate instead of
 *     discarding what someone recorded
 *   - never letting bad stored data stop the app from opening. Someone who
 *     cannot start the app cannot start anything, which is the one failure this
 *     app must not have. Unreadable data is set aside, not deleted, and the app
 *     opens empty.
 */

const KEY = 'start_app_v1'
const QUARANTINE_KEY = 'start_app_v1_unreadable'

export const CURRENT_VERSION = 2

export function emptyDocument() {
  return { version: CURRENT_VERSION, sessions: [] }
}

/**
 * Brings a document from an older shape up to the current one.
 *
 * Each step is a separate function so a future change is an addition rather
 * than an edit to existing logic. Applied in order, so a document can arrive
 * from any past version.
 */
const migrations = {
  /**
   * 1 → 2: `finished` became `completedPlannedTime`.
   *
   * The old name read as "did this session finish", which invited the reading
   * "did they finish for the day" — two different things that must not be
   * confused here, because one of them is a judgement about the person and the
   * other is a plain fact about the clock. The value never meant the former;
   * only the name and the documentation suggested it did.
   *
   * The old field is dropped rather than kept alongside: two names for one fact
   * is how they drift apart.
   */
  2: (doc) => ({
    ...doc,
    sessions: doc.sessions.map(({ finished, ...session }) => ({
      ...session,
      completedPlannedTime: finished === true,
    })),
  }),
}

export function migrate(doc) {
  let current = doc
  while (current.version < CURRENT_VERSION) {
    const step = migrations[current.version + 1]
    if (!step) {
      // A gap in the chain would silently skip a shape change, so stop instead.
      throw new Error(`no migration to version ${current.version + 1}`)
    }
    current = step(current)
    current.version = current.version + 1
  }
  return current
}

/** Everything a stored document must look like before the app will trust it. */
export function isUsable(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false
  if (typeof doc.version !== 'number' || !Number.isFinite(doc.version)) return false
  if (doc.version < 1 || doc.version > CURRENT_VERSION) return false
  if (!Array.isArray(doc.sessions)) return false
  return doc.sessions.every(isUsableSession)
}

export function isUsableSession(session) {
  if (!session || typeof session !== 'object') return false
  if (typeof session.id !== 'string' || session.id === '') return false
  if (typeof session.task !== 'string') return false
  if (typeof session.plannedMinutes !== 'number' || !Number.isFinite(session.plannedMinutes)) return false
  if (typeof session.startedAt !== 'number' || !Number.isFinite(session.startedAt)) return false
  return true
}

/**
 * Reads the document, and never throws.
 *
 * Returns `{ doc, recovered }`. `recovered` is true when something was wrong
 * and the app is opening empty; the caller can mention it once rather than
 * pretending nothing happened.
 */
export function load(store = safeLocalStorage()) {
  if (!store) return { doc: emptyDocument(), recovered: false }

  let raw = null
  try {
    raw = store.getItem(KEY)
  } catch {
    return { doc: emptyDocument(), recovered: false }
  }
  if (raw === null) return { doc: emptyDocument(), recovered: false }

  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { doc: emptyDocument(), recovered: quarantine(store, raw) }
  }

  let doc = parsed
  if (isUsable(doc)) {
    try {
      doc = migrate(doc)
    } catch {
      return { doc: emptyDocument(), recovered: quarantine(store, raw) }
    }
    return { doc, recovered: false }
  }

  // Partly readable is still worth keeping: drop only the records that fail.
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.sessions)) {
    const kept = parsed.sessions.filter(isUsableSession)
    if (kept.length > 0) {
      return { doc: { version: CURRENT_VERSION, sessions: kept }, recovered: true }
    }
  }
  return { doc: emptyDocument(), recovered: quarantine(store, raw) }
}

export function save(doc, store = safeLocalStorage()) {
  if (!store) return false
  try {
    store.setItem(KEY, JSON.stringify(doc))
    return true
  } catch {
    // Out of quota, or private mode. The app keeps working on the in-memory
    // copy for this session rather than dying at the point of writing.
    return false
  }
}

/** Keeps the unreadable text under a separate key instead of destroying it. */
function quarantine(store, raw) {
  try {
    store.setItem(QUARANTINE_KEY, raw)
  } catch {
    // Even the rescue can fail on a full store. Opening the app still matters more.
  }
  return true
}

function safeLocalStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ records --

export function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * One run of the timer.
 *
 * `continuedFrom` links a 「もう5分やる」 to the run before it. Both are kept as
 * records — the time spent is real either way — but only the first one counts
 * as a start. Going from doing nothing to doing something is the hard step this
 * app exists for; carrying on when you are already going is a different and
 * much easier thing, and counting it would inflate the one number that matters.
 *
 * `completedPlannedTime` is a fact about the clock: did the timer reach zero.
 * It is not a verdict on the person, and pressing 「今日は終了する」 never
 * changes it.
 */
export function createSession({ task, firstStep, plannedMinutes, mood, continuedFrom = null, now = Date.now() }) {
  return {
    id: newId(),
    task: String(task ?? '').trim(),
    firstStep: String(firstStep ?? '').trim(),
    plannedMinutes: Number(plannedMinutes),
    mood: mood ?? null,
    startedAt: now,
    endedAt: null,
    actualSeconds: 0,
    completedPlannedTime: false,
    continuedFrom,
  }
}

export function closeSession(session, { now = Date.now(), completedPlannedTime = true } = {}) {
  return {
    ...session,
    endedAt: now,
    actualSeconds: Math.max(0, Math.round((now - session.startedAt) / 1000)),
    completedPlannedTime,
  }
}

// ------------------------------------------------------------------ reading --

/** Most recent distinct task names, for the "start this again" shortcut. */
export function recentTasks(doc, limit = 3) {
  const seen = new Set()
  const out = []
  for (let index = doc.sessions.length - 1; index >= 0 && out.length < limit; index--) {
    const task = doc.sessions[index].task
    if (!task || seen.has(task)) continue
    seen.add(task)
    out.push(task)
  }
  return out
}

/**
 * How many times someone went from doing nothing to doing something.
 *
 * The number this app is about — so an extension does not add to it. Pressing
 * 「もう5分やる」 is worth recording, but it is not the step this app exists to
 * make easier, and counting it would quietly make the number mean less.
 */
export function startCount(doc) {
  return doc.sessions.filter(isFirstStart).length
}

export function startCountOn(doc, date = new Date()) {
  const key = dayKey(date)
  return doc.sessions.filter(
    (session) => isFirstStart(session) && dayKey(new Date(session.startedAt)) === key,
  ).length
}

export function isFirstStart(session) {
  return session.continuedFrom === null || session.continuedFrom === undefined
}

/** Every run belonging to one start, oldest first. Includes the start itself. */
export function segmentsOf(doc, startId) {
  const out = []
  let current = startId
  for (const session of doc.sessions) {
    if (session.id === current || session.continuedFrom === current) {
      out.push(session)
      if (session.continuedFrom === current) current = session.id
    }
  }
  return out
}

/** Total minutes spent across a start and everything that continued it. */
export function totalMinutesOf(doc, startId) {
  const seconds = segmentsOf(doc, startId).reduce((sum, session) => sum + (session.actualSeconds ?? 0), 0)
  return Math.round(seconds / 60)
}

export function dayKey(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
