/**
 * Screen flow and wiring.
 *
 * The app is one document with seven sections; exactly one is visible. There is
 * no router, because there is nothing to link to — this is a single sitting from
 * "what shall I start" to "that's enough for today".
 *
 * Storage and the countdown live in their own modules. This file decides what
 * is on screen and what a press means, and nothing else.
 */

import {
  closeSession,
  createSession,
  load,
  recentTasks,
  save,
  startCount,
  startCountOn,
  totalMinutesOf,
} from './storage.js'
import { createTimer, elapsedMinutes, formatRemaining } from './timer.js'

const DURATIONS = [5, 15, 30]
const DEFAULT_MINUTES = 5

const screens = new Map()
for (const element of document.querySelectorAll('[data-screen]')) {
  screens.set(element.dataset.screen, element)
}

const el = (role) => document.querySelector(`[data-role="${role}"]`)

const view = {
  countLine: el('count-line'),
  recent: el('recent'),
  recentList: el('recent-list'),
  taskInput: el('task-input'),
  taskHint: el('task-hint'),
  durations: el('durations'),
  moods: el('moods'),
  stepInput: el('step-input'),
  runningTask: el('running-task'),
  runningStep: el('running-step'),
  remaining: el('remaining'),
  pauseButton: el('pause-button'),
  doneTitle: el('done-title'),
  doneCount: el('done-count'),
  againMinutes: el('again-minutes'),
  byeSub: el('bye-sub'),
  notice: el('notice'),
  installHint: el('install-hint'),
}

// ------------------------------------------------------------------- state --

const loaded = load()
let doc = loaded.doc

/** What the current run is about. Rebuilt each time someone starts. */
let draft = { task: '', firstStep: '', minutes: DEFAULT_MINUTES, mood: null }
let activeSession = null
/** The first run of the current chain. Extensions hang off this one. */
let startId = null
let history = []

const timer = createTimer({
  onTick: (ms) => {
    view.remaining.textContent = formatRemaining(ms)
  },
  onDone: () => {
    finishSession({ completedPlannedTime: true })
    celebrate()
  },
})

// ------------------------------------------------------------------ screens --

function show(name, { remember = true } = {}) {
  for (const [key, element] of screens) element.hidden = key !== name
  if (remember) history.push(name)
  const focusable = screens.get(name).querySelector('input, button')
  // Only pull focus on the text screens: on the timer it would summon the
  // keyboard on a phone for no reason.
  if (focusable && focusable.tagName === 'INPUT') focusable.focus()
}

function goBack() {
  history.pop()
  const previous = history[history.length - 1] ?? 'home'
  history = history.slice(0, -1)
  show(previous)
}

function goHome() {
  history = []
  startId = null
  draft = { task: '', firstStep: '', minutes: DEFAULT_MINUTES, mood: null }
  view.taskInput.value = ''
  view.stepInput.value = ''
  setMinutes(DEFAULT_MINUTES)
  setMood(null)
  renderHome()
  show('home')
}

function renderHome() {
  const today = startCountOn(doc)
  const total = startCount(doc)
  view.countLine.textContent =
    total === 0 ? '' : today > 0 ? `今日 ${today}回 始めた（ぜんぶで ${total}回）` : `これまで ${total}回 始めた`

  const recent = recentTasks(doc, 3)
  view.recent.hidden = recent.length === 0
  view.recentList.replaceChildren(
    ...recent.map((task) => {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = task
      button.addEventListener('click', () => {
        draft.task = task
        view.taskInput.value = task
        show('duration')
      })
      item.append(button)
      return item
    }),
  )
}

// -------------------------------------------------------------- selections --

function setMinutes(minutes) {
  draft.minutes = minutes
  for (const button of view.durations.querySelectorAll('[data-minutes]')) {
    button.setAttribute('aria-checked', String(Number(button.dataset.minutes) === minutes))
  }
}

function setMood(mood) {
  draft.mood = mood
  for (const chip of view.moods.querySelectorAll('[data-mood]')) {
    chip.setAttribute('aria-checked', String(chip.dataset.mood === mood))
  }
}

// ----------------------------------------------------------------- session --

function beginSession({ continuedFrom = null } = {}) {
  activeSession = createSession({
    task: draft.task,
    firstStep: draft.firstStep,
    plannedMinutes: draft.minutes,
    mood: draft.mood,
    continuedFrom,
  })
  // Recorded at the moment of starting, not at the end: a run that gets
  // interrupted still happened. Whether it counts as a *start* is decided by
  // continuedFrom, not by this write.
  if (continuedFrom === null) startId = activeSession.id
  doc = { ...doc, sessions: [...doc.sessions, activeSession] }
  persist()

  view.runningTask.textContent = draft.task
  view.runningStep.textContent = draft.firstStep ? `まず、${draft.firstStep}` : ''
  view.pauseButton.textContent = '一時停止'
  show('timer')
  timer.start(draft.minutes)
}

function finishSession({ completedPlannedTime }) {
  timer.stop()
  if (!activeSession) return
  const closed = closeSession(activeSession, { completedPlannedTime })
  doc = {
    ...doc,
    sessions: doc.sessions.map((session) => (session.id === closed.id ? closed : session)),
  }
  persist()

  const minutes = elapsedMinutes(closed.startedAt, closed.endedAt)
  view.doneTitle.textContent = minutes >= 1 ? `${minutes}分やった！` : 'はじめられた！'

  // After an extension the start count has not moved — continuing is not a new
  // start — so showing it again would look like nothing happened. Show the
  // total time instead, which is what did grow.
  const wholeRun = totalMinutesOf(doc, startId)
  view.doneCount.textContent =
    closed.continuedFrom === null ? `これで ${startCount(doc)}回目` : `つづけて 合計 ${wholeRun}分`
  view.againMinutes.textContent = String(draft.minutes)
  activeSession = closed
  show('done')
}

function persist() {
  const ok = save(doc)
  if (!ok) notify('保存できませんでした。この画面のあいだは残ります')
}

// --------------------------------------------------------------- reactions --

/**
 * A short sound and a buzz when the time is up.
 *
 * Both are best-effort. Browsers block audio without a prior interaction and
 * ignore vibration on most desktops, so every call is wrapped: a silent finish
 * is fine, a thrown error on the finish line is not. WebAudio is used rather
 * than an audio file so nothing extra has to be downloaded or cached.
 */
function celebrate() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (Ctx) {
      const ctx = new Ctx()
      const gain = ctx.createGain()
      gain.gain.setValueAtTime(0.0001, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.9)
      gain.connect(ctx.destination)
      for (const [frequency, at] of [[660, 0], [880, 0.16]]) {
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.value = frequency
        osc.connect(gain)
        osc.start(ctx.currentTime + at)
        osc.stop(ctx.currentTime + at + 0.5)
      }
      setTimeout(() => ctx.close().catch(() => {}), 1200)
    }
  } catch {
    // no sound; not a failure
  }
  try {
    navigator.vibrate?.([120, 60, 120])
  } catch {
    // no vibration; not a failure
  }
}

let noticeTimer = null
function notify(message) {
  view.notice.textContent = message
  view.notice.hidden = false
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    view.notice.hidden = true
  }, 4000)
}

// ------------------------------------------------------------------ events --

document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-action]')
  if (trigger) {
    handleAction(trigger.dataset.action)
    return
  }
  const duration = event.target.closest('[data-minutes]')
  if (duration) {
    setMinutes(Number(duration.dataset.minutes))
    return
  }
  const mood = event.target.closest('[data-mood]')
  if (mood) {
    // Pressing the chosen one again clears it: this is optional information and
    // there has to be a way back to having said nothing.
    setMood(draft.mood === mood.dataset.mood ? null : mood.dataset.mood)
  }
})

function handleAction(action) {
  switch (action) {
    case 'begin':
      show('task')
      break
    case 'back':
      goBack()
      break
    case 'task-next':
      submitTask()
      break
    case 'duration-next':
      show('step')
      break
    case 'start':
      draft.firstStep = view.stepInput.value.trim()
      beginSession()
      break
    case 'toggle-pause':
      if (timer.isPaused) {
        timer.resume()
        view.pauseButton.textContent = '一時停止'
      } else {
        timer.pause()
        view.pauseButton.textContent = '再開する'
      }
      break
    case 'finish-early':
      finishSession({ completedPlannedTime: false })
      break
    case 'again':
      beginSession({ continuedFrom: activeSession?.id ?? null })
      break
    case 'stop-today':
      view.byeSub.textContent =
        startCountOn(doc) > 1 ? '今日は何度も始められた' : '始められたことが、いちばん大きい'
      show('bye')
      break
    case 'home':
      goHome()
      break
    case 'dismiss-install':
      view.installHint.hidden = true
      try { localStorage.setItem('start_app_install_hint_seen', '1') } catch {}
      break
    default:
      break
  }
}

function submitTask() {
  const value = view.taskInput.value.trim()
  if (!value) {
    // Not an error message. Nothing has gone wrong; there is just nothing to start yet.
    view.taskHint.textContent = 'ひとことでいいので書いてみて'
    view.taskInput.focus()
    return
  }
  view.taskHint.innerHTML = '&nbsp;'
  draft.task = value
  show('duration')
}

view.taskInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submitTask()
})

view.stepInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    draft.firstStep = view.stepInput.value.trim()
    beginSession()
  }
})

// Coming back from the lock screen or another app. The countdown reads a
// deadline rather than counting ticks, so this only asks it to repaint sooner.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) timer.refresh()
})
window.addEventListener('pageshow', () => timer.refresh())

// -------------------------------------------------------------------- boot --

function maybeShowInstallHint() {
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true
  if (standalone) return
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  if (!iOS) return
  let seen = null
  try { seen = localStorage.getItem('start_app_install_hint_seen') } catch {}
  if (seen) return
  view.installHint.hidden = false
}

if (loaded.recovered) {
  notify('前の記録の一部が読めませんでした。今の記録から続けられます')
}

setMinutes(DEFAULT_MINUTES)
goHome()
maybeShowInstallHint()

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Offline support is a bonus here, not a requirement to run.
    })
  })
}

export { DURATIONS }
