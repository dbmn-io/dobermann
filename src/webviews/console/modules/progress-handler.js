// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #197: Progress Handler Module
 *
 * Handles timer, progress, and export progress functionality for the
 * execution report webview.
 *
 * Architecture Compliance:
 * - Extracted from inline JavaScript in report.html
 * - Follows same pattern as raw-tab-handler.js
 * - Uses globals from time-formatter.js (formatDuration, formatETA, formatIndividualDuration)
 * - Calls window.updateButtonVisibility() and window.updateLogsTabIndicator() (remain in report.html)
 * - Uses requestAnimationFrame instead of setInterval for timer updates
 *   to prevent throttling when the event loop is saturated by batch messages
 */

/**
 * The Console's progress box: the design system's <dbmn-progress id="progress-display"> on the
 * right of its footer (shared/dbmn-footer.js). Everything the Console says about how far a run has
 * got goes through here, so the box is written in one place:
 *
 *   ConsoleProgress.show() / hide() / isHidden()
 *   ConsoleProgress.phase('Executing')           what is happening
 *   ConsoleProgress.count('91/501')              how far
 *   ConsoleProgress.fill(18)                     the bar, as a percentage
 *   ConsoleProgress.state('running')             the run's state: its colour (ok, warn, error) and,
 *                                                for loading, processing and busy, a moving bar
 *   ConsoleProgress.elapsed('2m 14s')            the clock
 *   ConsoleProgress.remaining('1m 20s left')     the time left, or a queued/waiting line; null: none
 *
 * The box shows one time beside the count: the time left while there is one, else the clock.
 */
const ConsoleProgress = (() => {
    let elapsedText = '';
    let remainingText = null;
    let stateName = '';
    const box = () => document.getElementById('progress-display');
    const TONE = { completed: 'ok', paused: 'warn', stopped: 'warn', cancelled: 'warn', error: 'error', failed: 'error' };
    const MOVING = ['loading', 'processing', 'busy'];
    function note() {
        const el = box();
        if (!el) return;
        const text = remainingText || elapsedText || '';
        if (text) el.setAttribute('note', text); else el.removeAttribute('note');
    }
    return {
        show() { const el = box(); if (el) el.classList.remove('hidden'); },
        hide() { const el = box(); if (el) el.classList.add('hidden'); },
        isHidden() { const el = box(); return !el || el.classList.contains('hidden'); },
        phase(text) {
            const el = box();
            if (text === undefined) return el ? el.getAttribute('phase') || '' : '';
            if (el) el.setAttribute('phase', text || '');
        },
        count(text) {
            const el = box();
            if (text === undefined) return el ? el.getAttribute('count') || '' : '';
            if (el) el.setAttribute('count', text || '');
        },
        fill(percent) {
            const el = box();
            if (percent === undefined) return el ? Number(el.getAttribute('value')) || 0 : 0;
            if (el) el.setAttribute('value', String(Math.max(0, Math.min(100, Number(percent) || 0))));
        },
        state(name) {
            if (name === undefined) return stateName;
            stateName = String(name || '');
            const el = box();
            if (!el) return;
            const words = stateName.split(/\s+/);
            const tone = words.map(w => TONE[w]).find(Boolean);
            if (tone) el.setAttribute('tone', tone); else el.removeAttribute('tone');
            el.toggleAttribute('busy', words.some(w => MOVING.includes(w)));
            el.dataset.state = stateName;
        },
        elapsed(text) { if (text === undefined) return elapsedText; elapsedText = text || ''; note(); },
        remaining(text) { if (text === undefined) return remainingText; remainingText = text || null; note(); }
    };
})();
if (typeof window !== 'undefined') window.ConsoleProgress = ConsoleProgress;

class ProgressHandler {
    constructor() {
        // Timer state
        this.executionStartTime = null;
        this.executionETA = null;
        this._rafId = null;
        this._lastDisplayedSecond = -1;
        this.fastTimerActive = false;
        this._pausedElapsed = 0;
        // Issue #312: true while a large batch streams in; the bar shows the load,
        // not the run, and execution repaints wait (see showLoadingProgress)
        this.loading = false;
        this._beforeLoading = null;
    }

    /**
     * Issue #312: a large batch streams into the Console in chunks. Show the
     * load in the execution progress bar — phase "Loading input rows" / "Loading
     * transactions", count loaded/total, the bar filling — not in a toast; the run's own
     * progress is already on the tab header and in the Activity drawer. While
     * loading, execution repaints of this bar are held off (`loading`); when the
     * last chunk lands the bar goes back to what the execution had painted,
     * and the live tallies repaint the count if the batch is still running.
     */
    showLoadingProgress(loaded, total, label = 'transactions') {
        if (typeof total !== 'number' || total < 0) return;
        const box = ConsoleProgress;
        if (!document.getElementById('progress-display')) return;

        if (!this.loading) {
            this._beforeLoading = {
                hidden: box.isHidden(), phase: box.phase(), count: box.count(),
                fill: box.fill(), state: box.state(), remaining: box.remaining()
            };
            this.loading = true;
        }

        if (loaded < total) {
            box.show();
            box.phase(`Loading ${label}`);
            box.count(`${loaded.toLocaleString()}/${total.toLocaleString()}`);
            box.fill(Math.round((loaded / total) * 100));
            box.state('loading');
            box.remaining(null);
            return;
        }

        // Done: hand the bar back to the execution
        const before = this._beforeLoading || {};
        this.loading = false;
        this._beforeLoading = null;
        box.phase(before.phase || '');
        box.count(before.count || '');
        box.fill(before.fill || 0);
        box.state(before.state || '');
        box.remaining(before.remaining || null);
        if (before.hidden) box.hide();
        const mgr = window.dynamicReportManager;
        if (mgr && mgr._progressTotal && typeof mgr.paintBatchProgress === 'function') {
            mgr.paintBatchProgress(); // the tallies moved while we were loading
        }
    }

    /**
     * Start timer with backend start time and ETA
     */
    startTimer(startTime, eta) {
        this.executionStartTime = startTime;
        this.executionETA = eta;

        // Clear any existing timer
        this._stopRAF();

        // For individual executions in RUNNING state, start fast timer (10ms updates)
        const isBatchExecution = !!window.currentBatchId;
        if (!isBatchExecution) {
            this._startFastTimer();
        } else {
            // Batch: Update via rAF, throttled to once per second
            this._lastDisplayedSecond = -1;
            this._startRAFLoop(false);
        }

        // Update immediately
        this._updateTimerDisplay();
    }

    /**
     * Fast timer for individual executions < 10s
     * Uses rAF for smooth updates, switches to 1s after 10s
     */
    _startFastTimer() {
        this.fastTimerActive = true;
        this._startRAFLoop(true);
    }

    /**
     * Start a requestAnimationFrame loop for timer updates.
     * rAF is prioritised by the browser for visual updates and won't get
     * starved the way setInterval does when the event loop is busy
     * processing hundreds of batch status messages per second.
     */
    _startRAFLoop(fast) {
        const tick = () => {
            if (!this.executionStartTime) return;

            const now = Date.now();
            const elapsedMs = now - this.executionStartTime;
            const currentSecond = Math.floor(elapsedMs / 1000);

            if (fast) {
                // Fast mode: update every frame for ms precision
                this._updateTimerDisplay();

                // Switch to slow mode after 10s
                if (elapsedMs >= 10000) {
                    this.fastTimerActive = false;
                    this._lastDisplayedSecond = currentSecond;
                    // Continue loop but in slow mode (fall through to next tick)
                }
            } else {
                // Slow mode: only update DOM when the displayed second changes
                if (currentSecond !== this._lastDisplayedSecond) {
                    this._lastDisplayedSecond = currentSecond;
                    this._updateTimerDisplay();
                }
            }

            this._rafId = requestAnimationFrame(tick);
        };

        this._rafId = requestAnimationFrame(tick);
    }

    /**
     * Stop the rAF loop
     */
    _stopRAF() {
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    /**
     * Update timer display
     */
    _updateTimerDisplay() {
        if (!this.executionStartTime) return;

        const now = Date.now();
        const elapsedMs = now - this.executionStartTime;
        const elapsedSeconds = Math.floor(elapsedMs / 1000);
        const elapsedSecondsPrecise = elapsedMs / 1000; // Keep decimal precision

        // Update elapsed time in progress bar
        ConsoleProgress.elapsed(this.formatElapsedTime(elapsedSeconds));

        // GitHub Issue #156: Update duration in Info tab (live updates during execution)
        const infoDuration = document.getElementById('info-duration');
        if (infoDuration) {
            // Detect batch vs individual execution
            const isBatchExecution = !!window.currentBatchId;

            // Format duration based on execution type
            if (isBatchExecution) {
                // Batch: Standard formatting (prep + execution time)
                infoDuration.textContent = formatDuration(elapsedSeconds);
            } else {
                // Individual: Millisecond precision for < 10s (use precise value)
                infoDuration.textContent = formatIndividualDuration(elapsedSecondsPrecise);
            }
        }

        // Update ETA countdown (GitHub Issue #104)
        if (this.executionETA && this._showEta !== false) {
            const remainingSeconds = Math.floor((this.executionETA - now) / 1000);
            ConsoleProgress.remaining(remainingSeconds > 0 ? `${formatETA(remainingSeconds)} left` : 'almost done');
        }
    }

    /**
     * Issue #311: should the clock be (re)started from this backend start time?
     * Yes when it has never started, and when the two disagree by more than
     * a tick — a resume's `now - total run time` versus a clock still parked
     * on this session's start.
     */
    clockDisagrees(startTime) {
        if (!this.executionStartTime) return true;
        return Math.abs(startTime - this.executionStartTime) > 2000;
    }

    /**
     * Stop timer
     */
    stopTimer() {
        // Save accumulated elapsed time for resume
        if (this.executionStartTime) {
            this._pausedElapsed = Date.now() - this.executionStartTime;
        }
        this._stopRAF();
        this.fastTimerActive = false;
    }

    /**
     * Reset timer
     */
    resetTimer() {
        this.stopTimer();
        this.executionStartTime = null;
        this.executionETA = null;
        this._lastDisplayedSecond = -1;
        this._pausedElapsed = 0;
    }

    /**
     * Handle progress updates from backend
     */
    handleProgressUpdate(payload) {
        if (!payload) {
            console.warn('[Report] Progress update payload is empty');
            return;
        }

        // Issue #115: a response body still arriving. Text and bar only: the run's clock and
        // status are the run's own messages' business.
        if (payload.receiving) {
            this.showReceiving(payload.receiving, payload.startTime);
            return;
        }

        // Show/hide progress display based on execution state
        const status = payload.status || payload.phase; // Support both new and old format

        // GitHub Issue #94: Track current status for pagination button visibility (R10.1)
        window.currentExecutionStatus = status;

        if (status === 'pending' && payload.waitingFor && payload.midRun && payload.startTime) {
            // #344: running, then waiting for VS Code (it closed mid-run; `startTime` is the run's).
            // The clock stops at the run time so far, not back to zero; the row says
            // what it waits for; Pause and Cancel stay, as the run is still live.
            ConsoleProgress.show();
            this.stopTimer();
            this.executionStartTime = payload.startTime;
            this._pausedElapsed = Date.now() - payload.startTime;
            ConsoleProgress.elapsed(this.formatElapsedTime(Math.floor(this._pausedElapsed / 1000)));
            ConsoleProgress.remaining(ProgressHandler.queuedStartText(payload, Date.now()));
            this.executionETA = null;
            this.updateProgressDisplay({ ...payload, status: 'waiting' });
            window.updateButtonVisibility('running');
        } else if (status === 'pending') {
            // Queued: execution hasn't begun, so there is nothing to time.
            // Issue #309: the opening "Starting..." message used to arrive
            // first and start the clock; a later 'pending' never stopped it,
            // so a queued batch showed a running timer and "Remaining:
            // calculating...". Reset the clock and say when it should start.
            // Every batch is also 'pending' while its first chunk is prepared
            // (the Console replays that on open) — not queued, so it reads
            // as preparing with the ETA still to be calculated.
            ConsoleProgress.show();
            this.resetTimer();
            const queued = ProgressHandler.isQueued(payload);
            if (queued) {
                this.showQueued(payload);
            } else {
                this.showCalculating();
            }
            this.updateProgressDisplay(queued ? payload : { ...payload, status: 'preparing' });
            window.updateButtonVisibility(status);
        } else if (status && status !== 'completed' && status !== 'error' && status !== 'stopped' && status !== 'paused') {
            ConsoleProgress.show();
            this._showEta = true;

            // Issue #336: running again after it had stopped (a reprocess in this Console, or a
            // resume): the last estimate is spent. Calculating until the engine sends a new one.
            if (['completed', 'error', 'stopped', 'paused'].includes(this._lastStatus)) {
                this.executionETA = payload.estimatedEndTime || null;
            }

            // Start/update timer. Issue #311: the backend's startTime is the
            // truth — it already excludes paused time and survives a reload
            // (now - total run time). Resync to it whenever it disagrees with
            // the local clock by more than a tick, instead of only when the
            // clock was never started; a resume used to restart from 0.
            if (!this.executionStartTime) {
                const startTime = payload.startTime || Date.now();
                this.startTimer(startTime, payload.estimatedEndTime);
            } else if (payload.startTime && Math.abs(payload.startTime - this.executionStartTime) > 2000) {
                this.startTimer(payload.startTime, payload.estimatedEndTime || this.executionETA);
            } else if (!this._rafId) {
                // Restart after a pause with no backend startTime — carry on from the paused elapsed
                this.executionStartTime = Date.now() - this._pausedElapsed;
                this.startTimer(this.executionStartTime, payload.estimatedEndTime);
            } else if (payload.estimatedEndTime && payload.estimatedEndTime !== this.executionETA) {
                // Update estimated end time if it changed
                this.executionETA = payload.estimatedEndTime;
            }
            // The timer only rewrites the ETA row once there is an estimate,
            // so until then it would keep the queued text ("After the current
            // batch") from before the batch started.
            if (!this.executionETA) {
                this.showCalculating();
            }

            this.updateProgressDisplay(payload);
            window.updateButtonVisibility(status);
        } else if (status === 'completed' || status === 'error' || status === 'stopped' || status === 'paused') {
            // Stop the timer so elapsed time freezes at its final value — but
            // KEEP the progress section (bar + elapsed time) visible. Only the
            // "Remaining: …" ETA row toggles: dropped on terminal states (it
            // makes no sense once nothing remains), kept while paused so the
            // user still sees elapsed + the last calculated remaining time.
            this.stopTimer();

            // (the time left stays only while paused with an estimate; done, the box says how long it took)
            this._showEta = status === 'paused' && !!this.executionETA;
            if (!this._showEta) ConsoleProgress.remaining(null);

            this.updateProgressDisplay(payload);
            window.updateButtonVisibility(status);
        }

        // Update Logs tab indicator based on streaming status
        window.updateLogsTabIndicator(status);
        this._lastStatus = status;
    }

    /**
     * Issue #115: a response body arriving, then being saved.
     *  - Total known (X-Total-Count for JSON Lines, or Content-Length): "Receiving 88,809 / 95,121
     *    records  93%", a real bar, and "71.6 MB · ≈1s left" under it.
     *  - No total (a streamed body usually has none): "Receiving 88,809 records  71.6 MB", a busy
     *    bar (never a full one: full reads as done), and the download speed under it.
     *  - All in: the bar at 100%, "Processing 95,121 records" ("Processing data" when not JSON
     *    Lines) as a turning barber pole, until the run's result repaints the footer.
     * The run's clock is left alone; `startTime` is when this request began, for speed and time left.
     */
    showReceiving(receiving, startTime) {
        if (this.loading) return; // Issue #312: the bar is showing the load
        const box = ConsoleProgress;
        if (!document.getElementById('progress-display')) return;
        box.show();

        const mb = bytes => `${(bytes / 1048576).toFixed(1)} MB`;
        const records = n => `${n.toLocaleString()} record${n === 1 ? '' : 's'}`;
        const { bytes, lines, totalBytes, totalRecords, jsonl, done } = receiving;
        const fraction = done ? null
            : jsonl && totalRecords ? Math.min(1, lines / totalRecords)
            : totalBytes ? Math.min(1, bytes / totalBytes)
            : null;

        if (done) box.phase(jsonl ? `Processing ${records(lines)}` : 'Processing data');
        else if (jsonl && totalRecords) box.phase(`Receiving ${lines.toLocaleString()} / ${records(totalRecords)}`);
        else box.phase(jsonl ? `Receiving ${records(lines)}` : 'Receiving');

        box.count(done ? '100%' : fraction !== null ? `${Math.floor(fraction * 100)}%` : mb(bytes));
        if (done) {
            box.fill(100);
            box.state('loading processing');
        } else if (fraction !== null) {
            box.fill(Math.floor(fraction * 100));
            box.state('loading');
        } else {
            box.fill(100);
            box.state('busy');
        }

        const seconds = startTime ? (Date.now() - startTime) / 1000 : 0;
        let detail = '';
        if (!done && fraction !== null) {
            // A time left once there is enough to go on; the MB the count no longer shows
            const left = fraction >= 0.05 && seconds >= 1 ? Math.max(1, Math.round(seconds * (1 - fraction) / fraction)) : 0;
            detail = left ? `${mb(bytes)} · ≈${this.formatElapsedTime(left)} left` : mb(bytes);
        } else if (!done && seconds >= 1) {
            detail = `${mb(bytes / seconds)}/s`;
        }
        box.remaining(detail || null);
    }

    /** Issue #309: a 'pending' payload from a real queue, not first-chunk preparation. */
    static isQueued(payload) {
        return !!(payload && (payload.queued || payload.queuedBehind || payload.expectedStartTime || payload.waitingFor));
    }

    /** ETA row before the first estimate arrives. */
    showCalculating() {
        // (no estimate yet: the box shows the clock)
        ConsoleProgress.remaining(null);
    }

    /**
     * Issue #309: the timing row while queued — no clock, and the expected
     * start in place of "Remaining". Pure text from backend fields:
     * `queuedBehind` (the batch ahead) and `expectedStartTime` (epoch ms,
     * absent until the batch ahead has enough throughput data).
     */
    showQueued(payload) {
        ConsoleProgress.elapsed('');
        ConsoleProgress.remaining(ProgressHandler.queuedStartText(payload, Date.now()));
    }

    /**
     * "Starts in ~4m" / "After Orders" / "After the current batch" — short, it shares
     * the row with the elapsed clock. Static so tests can call it without a DOM;
     * `now` is passed in for the same reason.
     */
    static queuedStartText(payload, now) {
        // #344: waiting for something to come, not for a batch ahead
        if (payload && payload.waitingFor) return `Please open ${payload.waitingFor}`;
        const at = payload && payload.expectedStartTime ? Math.round((payload.expectedStartTime - now) / 1000) : 0;
        if (at > 0) return `Starts in ~${formatETA(at)}`;
        return payload && payload.queuedBehind ? `After ${payload.queuedBehind}` : 'After the current batch';
    }

    /**
     * Update progress display elements
     */
    updateProgressDisplay(payload) {
        if (this.loading) return; // Issue #312: the bar is showing the load

        // Update phase text
        const status = payload.status || payload.phase; // Support both new and old format
        if (status) ConsoleProgress.phase(this.formatPhaseText(status));

        // GitHub Issue #104: the count and the bar are painted from the transactions' results
        // (real time); this keeps the box's colour in step with the run's state
        ConsoleProgress.state(status || 'unknown');

        // Timer handles all timing automatically (elapsed time and ETA display)
    }

    /**
     * Format elapsed time - ALWAYS shows seconds for user feedback
     */
    formatElapsedTime(seconds) {
        if (!seconds || seconds < 0) return '0s';

        if (seconds < 60) {
            return `${seconds}s`;
        } else if (seconds < 3600) {
            const mins = Math.floor(seconds / 60);
            const secs = seconds % 60;
            return `${mins}m ${secs}s`;
        } else {
            const hours = Math.floor(seconds / 3600);
            const mins = Math.floor((seconds % 3600) / 60);
            const secs = seconds % 60;
            return `${hours}h ${mins}m ${secs}s`;
        }
    }

    /**
     * Handle export progress updates from backend
     * Shows progress bar during export operations
     */
    handleExportProgress(payload) {
        if (!payload) {
            console.warn('[Report] Export progress payload is empty');
            return;
        }

        const box = ConsoleProgress;
        // Shown when the export starts
        if (payload.progress === 0) box.show();
        box.phase(`Exporting ${payload.format.toUpperCase()}...`);
        if (payload.rowsProcessed !== undefined && payload.totalRows !== undefined) {
            box.count(`${payload.rowsProcessed.toLocaleString()}/${payload.totalRows.toLocaleString()} rows`);
        }
        box.fill(Math.min(100, Math.max(0, payload.progress)));
        box.state('exporting');
        // Hidden once done, after a moment at 100% so the user sees it finish
        if (payload.progress >= 100) setTimeout(() => box.hide(), 500);
    }

    /**
     * Format phase text for display
     */
    formatPhaseText(phase) {
        switch (phase) {
            case 'preparing': return 'Preparing';
            case 'queued': return 'Queued';
            case 'executing':
            case 'running': return 'Executing';
            case 'pending': return 'Queued';
            case 'waiting': return 'Waiting';   // #344: for VS Code, mid-run
            case 'paused': return 'Paused';
            case 'completed': return 'Completed';
            case 'stopped': return 'Stopped';  // GitHub Issue #159: Stopped on error
            case 'error':
            case 'failed': return 'Failed';
            default: return 'Processing';
        }
    }

    /**
     * Parse progress from message text
     */
    parseProgressFromMessage(message) {
        if (!message) return {};

        // Parse "X of Y" format
        const ofMatch = message.match(/(\d+)\s+of\s+(\d+)/);
        if (ofMatch) {
            return {
                current: parseInt(ofMatch[1]),
                total: parseInt(ofMatch[2])
            };
        }

        // Parse "X/Y" format
        const slashMatch = message.match(/(\d+)\/(\d+)/);
        if (slashMatch) {
            return {
                current: parseInt(slashMatch[1]),
                total: parseInt(slashMatch[2])
            };
        }

        return {};
    }
}

