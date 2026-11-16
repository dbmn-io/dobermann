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
        const display = document.getElementById('progress-display');
        const phase = document.getElementById('progress-phase');
        const count = document.getElementById('progress-count');
        const fill = document.getElementById('progress-bar-fill');
        const eta = document.getElementById('progress-eta');
        if (!display || !phase || !count || !fill) return;

        if (!this.loading) {
            this._beforeLoading = {
                hidden: display.classList.contains('hidden'),
                phase: phase.textContent, count: count.textContent,
                width: fill.style.width, className: fill.className,
                etaDisplay: eta ? eta.style.display : ''
            };
            this.loading = true;
        }

        if (loaded < total) {
            display.classList.remove('hidden');
            phase.textContent = `Loading ${label}`;
            count.textContent = `${loaded.toLocaleString()}/${total.toLocaleString()}`;
            fill.style.width = `${Math.round((loaded / total) * 100)}%`;
            fill.className = 'progress-bar-fill loading';
            if (eta) eta.style.display = 'none';
            return;
        }

        // Done: hand the bar back to the execution
        const before = this._beforeLoading || {};
        this.loading = false;
        this._beforeLoading = null;
        phase.textContent = before.phase || '';
        count.textContent = before.count || '';
        fill.style.width = before.width || '';
        fill.className = before.className || 'progress-bar-fill';
        if (eta) eta.style.display = before.etaDisplay || '';
        if (before.hidden) display.classList.add('hidden');
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
        const elapsedElement = document.getElementById('progress-elapsed');
        if (elapsedElement) {
            elapsedElement.innerHTML = window.Icons.label('timer', this.formatElapsedTime(elapsedSeconds));
        }

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
        const etaElement = document.getElementById('progress-eta');
        if (etaElement && this.executionETA) {
            const remainingSeconds = Math.floor((this.executionETA - now) / 1000);
            if (remainingSeconds > 0) {
                etaElement.innerHTML = window.Icons.label('timer', `Remaining: ${formatETA(remainingSeconds)}`);
            } else {
                etaElement.innerHTML = window.Icons.label('timer', 'Remaining: 0s');
            }
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
        const progressDisplay = document.getElementById('progress-display');
        const status = payload.status || payload.phase; // Support both new and old format

        // GitHub Issue #94: Track current status for pagination button visibility (R10.1)
        window.currentExecutionStatus = status;

        if (status === 'pending' && payload.waitingFor && payload.midRun && payload.startTime) {
            // #344: running, then waiting for VS Code (it closed mid-run; `startTime` is the run's).
            // The clock stops at the run time so far, not back to zero; the row says
            // what it waits for; Pause and Cancel stay, as the run is still live.
            progressDisplay.classList.remove('hidden');
            this.stopTimer();
            this.executionStartTime = payload.startTime;
            this._pausedElapsed = Date.now() - payload.startTime;
            const elapsedElement = document.getElementById('progress-elapsed');
            if (elapsedElement) {
                elapsedElement.innerHTML = window.Icons.label('timer', this.formatElapsedTime(Math.floor(this._pausedElapsed / 1000)));
            }
            const etaElement = document.getElementById('progress-eta');
            if (etaElement) {
                etaElement.innerHTML = window.Icons.label('timer', ProgressHandler.queuedStartText(payload, Date.now()));
                etaElement.style.display = '';
            }
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
            progressDisplay.classList.remove('hidden');
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
            progressDisplay.classList.remove('hidden');

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

            const etaElement = document.getElementById('progress-eta');
            if (etaElement) {
                etaElement.style.display = (status === 'paused' && this.executionETA) ? '' : 'none';
            }

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
        const display = document.getElementById('progress-display');
        const phase = document.getElementById('progress-phase');
        const count = document.getElementById('progress-count');
        const fill = document.getElementById('progress-bar-fill');
        const eta = document.getElementById('progress-eta');
        if (!display || !phase || !count || !fill) return;
        display.classList.remove('hidden');

        const mb = bytes => `${(bytes / 1048576).toFixed(1)} MB`;
        const records = n => `${n.toLocaleString()} record${n === 1 ? '' : 's'}`;
        const { bytes, lines, totalBytes, totalRecords, jsonl, done } = receiving;
        const fraction = done ? null
            : jsonl && totalRecords ? Math.min(1, lines / totalRecords)
            : totalBytes ? Math.min(1, bytes / totalBytes)
            : null;

        if (done) phase.textContent = jsonl ? `Processing ${records(lines)}` : 'Processing data';
        else if (jsonl && totalRecords) phase.textContent = `Receiving ${lines.toLocaleString()} / ${records(totalRecords)}`;
        else phase.textContent = jsonl ? `Receiving ${records(lines)}` : 'Receiving';

        count.textContent = done ? '100%' : fraction !== null ? `${Math.floor(fraction * 100)}%` : mb(bytes);
        if (done) {
            fill.style.width = '100%';
            fill.className = 'progress-bar-fill loading processing';
        } else if (fraction !== null) {
            fill.style.width = `${Math.floor(fraction * 100)}%`;
            fill.className = 'progress-bar-fill loading';
        } else {
            fill.style.width = '100%';
            fill.className = 'progress-bar-fill busy';
        }

        if (!eta) return;
        const seconds = startTime ? (Date.now() - startTime) / 1000 : 0;
        let detail = '';
        if (!done && fraction !== null) {
            // A time left once there is enough to go on; the MB the count no longer shows
            const left = fraction >= 0.05 && seconds >= 1 ? Math.max(1, Math.round(seconds * (1 - fraction) / fraction)) : 0;
            detail = left ? `${mb(bytes)} · ≈${this.formatElapsedTime(left)} left` : mb(bytes);
        } else if (!done && seconds >= 1) {
            detail = `${mb(bytes / seconds)}/s`;
        }
        eta.textContent = detail;
        eta.style.display = detail ? '' : 'none';
    }

    /** Issue #309: a 'pending' payload from a real queue, not first-chunk preparation. */
    static isQueued(payload) {
        return !!(payload && (payload.queued || payload.queuedBehind || payload.expectedStartTime || payload.waitingFor));
    }

    /** ETA row before the first estimate arrives. */
    showCalculating() {
        const etaElement = document.getElementById('progress-eta');
        if (etaElement) {
            etaElement.innerHTML = window.Icons.label('timer', 'Remaining: calculating...');
            etaElement.style.display = '';
        }
    }

    /**
     * Issue #309: the timing row while queued — no clock, and the expected
     * start in place of "Remaining". Pure text from backend fields:
     * `queuedBehind` (the batch ahead) and `expectedStartTime` (epoch ms,
     * absent until the batch ahead has enough throughput data).
     */
    showQueued(payload) {
        const elapsedElement = document.getElementById('progress-elapsed');
        if (elapsedElement) {
            elapsedElement.innerHTML = window.Icons.label('hourglass', 'Queued');
        }
        const etaElement = document.getElementById('progress-eta');
        if (etaElement) {
            etaElement.innerHTML = window.Icons.label('timer', ProgressHandler.queuedStartText(payload, Date.now()));
            etaElement.style.display = '';
        }
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
        const phaseElement = document.getElementById('progress-phase');
        const status = payload.status || payload.phase; // Support both new and old format
        if (phaseElement && status) {
            const phaseText = this.formatPhaseText(status);
            phaseElement.textContent = phaseText;
        }

        // GitHub Issue #104: Progress count/bar now updated by transaction results (real-time)
        // This function only updates ETA (from timer - once per minute)
        // Keep progress bar color class in sync with status
        const progressBarFill = document.getElementById('progress-bar-fill');
        if (progressBarFill) {
            // Only update color class based on status (width updated by handleMemberResultUpdate)
            const statusVal = payload.status || payload.phase;
            progressBarFill.className = `progress-bar-fill ${statusVal || 'unknown'}`;
        }

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

        const progressDisplay = document.getElementById('progress-display');
        const progressPhase = document.getElementById('progress-phase');
        const progressCount = document.getElementById('progress-count');
        const progressBarFill = document.getElementById('progress-bar-fill');

        // Show progress display when export starts
        if (payload.progress === 0) {
            if (progressDisplay) {
                progressDisplay.classList.remove('hidden');
            }
        }

        // Update progress text
        if (progressPhase) {
            const text = `Exporting ${payload.format.toUpperCase()}...`;
            progressPhase.textContent = text;
        }

        // Update row count
        if (progressCount && payload.rowsProcessed !== undefined && payload.totalRows !== undefined) {
            const text = `${payload.rowsProcessed.toLocaleString()}/${payload.totalRows.toLocaleString()} rows`;
            progressCount.textContent = text;
        }

        // Update progress bar
        if (progressBarFill) {
            const percentage = Math.min(100, Math.max(0, payload.progress));
            progressBarFill.style.width = `${percentage}%`;
            progressBarFill.className = 'progress-bar-fill exporting';
        }

        // Hide progress display when export completes
        if (payload.progress >= 100) {
            setTimeout(() => {
                if (progressDisplay) {
                    progressDisplay.classList.add('hidden');
                }
            }, 500); // Brief delay so user sees 100% completion
        }
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

