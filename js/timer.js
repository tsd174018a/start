/**
 * The countdown.
 *
 * Built around a deadline, not a tick count. A phone screen locks, the browser
 * throttles background timers, the tab gets suspended — under all of those an
 * interval that decrements a counter falls behind by however long the app was
 * away, and comes back claiming there is more time left than there is. So the
 * only thing that decides the remaining time is `deadline - now`, and the
 * interval exists purely to repaint. Coming back from the background needs no
 * repair logic: the next repaint is already correct.
 *
 * Pauses are stored as accumulated paused milliseconds, so the deadline can be
 * pushed out by exactly the time spent paused.
 */

export function createTimer({ now = () => Date.now(), onTick = () => {}, onDone = () => {} } = {}) {
  let deadline = 0
  let pausedAt = null
  let handle = null
  let running = false
  let finished = false

  function remainingMs() {
    if (deadline === 0) return 0
    const reference = pausedAt === null ? now() : pausedAt
    return Math.max(0, deadline - reference)
  }

  function paint() {
    const remaining = remainingMs()
    onTick(remaining)
    if (remaining === 0 && !finished) {
      finished = true
      stopInterval()
      running = false
      onDone()
    }
  }

  function startInterval() {
    stopInterval()
    // 250ms rather than 1000ms so the displayed second changes close to when it
    // actually changes; the cost is nil and a second that visibly lags feels
    // broken.
    handle = setInterval(paint, 250)
  }

  function stopInterval() {
    if (handle !== null) {
      clearInterval(handle)
      handle = null
    }
  }

  return {
    start(minutes) {
      deadline = now() + Math.round(minutes * 60 * 1000)
      pausedAt = null
      finished = false
      running = true
      startInterval()
      paint()
    },
    pause() {
      if (!running || pausedAt !== null) return
      pausedAt = now()
      stopInterval()
      paint()
    },
    resume() {
      if (!running || pausedAt === null) return
      deadline += now() - pausedAt
      pausedAt = null
      startInterval()
      paint()
    },
    stop() {
      running = false
      pausedAt = null
      stopInterval()
    },
    /** Called on visibility change. Nothing to repair — just repaint sooner. */
    refresh() {
      if (running) paint()
    },
    get isRunning() {
      return running
    },
    get isPaused() {
      return pausedAt !== null
    },
    remainingMs,
  }
}

/** "05:00" from milliseconds. Rounds up so the last second is shown as 1, not 0. */
export function formatRemaining(ms) {
  const totalSeconds = Math.ceil(Math.max(0, ms) / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** Whole minutes actually spent, for the "○分やった！" line. */
export function elapsedMinutes(startedAt, endedAt) {
  return Math.max(0, Math.round((endedAt - startedAt) / 60000))
}
