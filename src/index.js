const telemetry = require('./telemetry');
const power = require('./power');
const state = require('./state');

/**
 * Formats a Date into local wall-clock timestamp (`HH:MM:SS` or `YYYY-MM-DD HH:MM:SS`).
 * Helps correlate agent transitions and sleep events against IDE and terminal logs.
 * @param {Date|string|number} [input]
 * @param {boolean} [includeDate]
 * @returns {string}
 */
function formatLocalTimestamp(input = new Date(), includeDate = false) {
    const date = input instanceof Date ? input : new Date(input);
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    if (!includeDate) return time;
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/**
 * Non-blocking sleep helper for async polling and countdowns.
 * Allows clean Ctrl+C / SIGINT interruption with zero CPU spin.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleepAsync(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs a full diagnostic audit of agent concurrency, OS power locks, and sleep capabilities.
 * @param {Object} options
 * @returns {Object}
 */
function checkStatus(options = {}) {
    const excludedSessionId = telemetry.resolveExcludedSessionId(options);
    const activeSessions = telemetry.findActiveSessions(options);
    const sleepStates = power.getAvailableSleepStates();
    const powerAudit = power.auditPowerRequests();
    const lastLatch = state.readStateLatch(options);

    return {
        checkedAt: new Date().toISOString(),
        readyToSleep: activeSessions.length === 0,
        excludedSessionId: excludedSessionId || null,
        activeSessions,
        sleepStates,
        powerAudit,
        lastLatch
    };
}

/**
 * Formats the diagnostic audit report into human-readable lines.
 * @param {Object} audit
 * @returns {string}
 */
function formatAuditReport(audit) {
    const lines = [];
    const stamp = formatLocalTimestamp(audit.checkedAt || new Date(), true);
    lines.push(`[${stamp}] Agent-zzz telemetry audit:`);

    if (audit.excludedSessionId) {
        lines.push(`Self-exclusion active: ignoring session [${audit.excludedSessionId.slice(0, 8)}]`);
    }

    if (audit.activeSessions.length === 0) {
        lines.push('Agent sessions: All external coding agent sessions are idle.');
    } else {
        lines.push(`Agent sessions: ${audit.activeSessions.length} active session(s) detected:`);
        for (const s of audit.activeSessions) {
            const atTime = s.lastActivityAt ? ` @ ${formatLocalTimestamp(s.lastActivityAt)}` : '';
            lines.push(`  - [${s.harness}:${s.shortId}] "${s.topic}" (step ${s.step}, ${s.state}, ${s.ageSec}s ago${atTime})`);
        }
    }

    if (audit.sleepStates && audit.sleepStates.available) {
        lines.push(`Supported states: ${audit.sleepStates.states.join(', ')}`);
    }

    if (audit.powerAudit) {
        lines.push(`OS wake locks: ${audit.powerAudit.message}`);
        if (audit.powerAudit.locks && audit.powerAudit.locks.length > 0) {
            for (const lock of audit.powerAudit.locks) {
                lines.push(`  - [${lock.category}] ${lock.entry}`);
            }
        }
    }

    return lines.join('\n');
}

/**
 * Waits asynchronously for all active external agent sessions to finish.
 * @param {Object} options
 * @param {Function} logFn
 * @returns {Promise<{ ready: boolean, message: string }>}
 */
async function waitForIdle(options = {}, logFn = console.log) {
    const timeoutMinutes = typeof options.timeoutMinutes === 'number' ? options.timeoutMinutes : 30;
    const pollSeconds = typeof options.pollIntervalSeconds === 'number' ? options.pollIntervalSeconds : 5;
    const timeoutMs = timeoutMinutes * 60 * 1000;
    const pollMs = pollSeconds * 1000;
    const startTime = Date.now();

    let active = telemetry.findActiveSessions(options);
    if (active.length === 0) {
        return { ready: true, message: `[${formatLocalTimestamp(new Date(), true)}] All external agent sessions are idle.` };
    }

    logFn(`\n[${formatLocalTimestamp(new Date(), true)}] Detected ${active.length} active agent session(s) in progress:`);
    for (const s of active) {
        const atTime = s.lastActivityAt ? ` @ ${formatLocalTimestamp(s.lastActivityAt)}` : '';
        logFn(`  - [${s.harness}:${s.shortId}] "${s.topic}" (step ${s.step}, ${s.state}, active ${s.ageSec}s ago${atTime})`);
    }
    logFn('Waiting for active turns and tools to complete before sleeping... (Pass --now to bypass)\n');

    while (active.length > 0) {
        if (timeoutMs > 0 && (Date.now() - startTime) > timeoutMs) {
            return {
                ready: false,
                message: `[${formatLocalTimestamp(new Date(), true)}] Timed out after ${timeoutMinutes}m waiting for ${active.length} active session(s) to finish.`
            };
        }

        await sleepAsync(pollMs);

        active = telemetry.findActiveSessions(options);
        if (active.length > 0) {
            const elapsedSec = Math.round((Date.now() - startTime) / 1000);
            const summary = active.map((s) => `${s.shortId} (step ${s.step}, ${s.state}, ${s.ageSec}s ago)`).join(', ');
            logFn(`[${formatLocalTimestamp()}] [+${elapsedSec}s] Still waiting on: ${summary}`);
        }
    }

    logFn(`[${formatLocalTimestamp(new Date(), true)}] All external agent sessions have settled into idle.`);
    return { ready: true, message: 'All external agent sessions are idle.' };
}

/**
 * Executes an abortable grace countdown before cutting OS power.
 * Prints clean newline intervals suitable for both interactive terminals and agent logs.
 * @param {number} delaySeconds
 * @param {string} mode
 * @param {Function} logFn
 * @returns {Promise<void>}
 */
async function runGraceCountdown(delaySeconds, mode, logFn = console.log) {
    if (delaySeconds <= 0) return;

    logFn(`\n[${formatLocalTimestamp(new Date(), true)}] System will enter ${mode} in ${delaySeconds} second(s). Press Ctrl+C to abort.`);

    let remaining = delaySeconds;
    while (remaining > 0) {
        const step = remaining > 10 ? 10 : (remaining > 5 ? 5 : 1);
        const waitSec = Math.min(step, remaining);
        await sleepAsync(waitSec * 1000);
        remaining -= waitSec;

        if (remaining > 0) {
            logFn(`  [${formatLocalTimestamp()}] ... ${remaining}s remaining before ${mode}`);
        }
    }
}

/**
 * Orchestrates the complete pre-flight audit, wait latch, countdown, and OS power transition.
 * @param {Object} options
 * @returns {Promise<{ success: boolean, message: string, audit?: Object }>}
 */
async function sleepSystem(options = {}) {
    const logFn = options.logFn || console.log;
    const delay = typeof options.delay === 'number' ? options.delay : 30;
    const mode = options.hibernate ? 'hibernate' : 'sleep';
    const force = options.force !== false;

    const initialAudit = checkStatus(options);

    // Check-only mode
    if (options.checkOnly) {
        return {
            success: true,
            audit: initialAudit,
            message: formatAuditReport(initialAudit)
        };
    }

    // Wait for concurrent sessions unless bypassed
    if (options.waitIdle !== false) {
        const waitRes = await waitForIdle(options, logFn);
        if (!waitRes.ready) {
            return {
                success: false,
                audit: initialAudit,
                message: waitRes.message
            };
        }
    }

    // Refresh OS power lock audit after sessions settle
    const finalAudit = checkStatus(options);
    if (finalAudit.powerAudit && finalAudit.powerAudit.locks.length > 0) {
        logFn(`\n[${formatLocalTimestamp()}] Warning: ${finalAudit.powerAudit.message}`);
        for (const lock of finalAudit.powerAudit.locks) {
            logFn(`  - [${lock.category}] ${lock.entry}`);
        }
        if (force) {
            logFn('Smart Force enabled: proceeding with requested sleep (pass --no-force to respect OS locks).');
        } else {
            return {
                success: false,
                audit: finalAudit,
                message: `[${formatLocalTimestamp(new Date(), true)}] Sleep aborted due to active OS wake locks (--no-force specified).`
            };
        }
    }

    // Dry-run mode
    if (options.dryRun) {
        const dryRes = power.executeSuspend({ ...options, dryRun: true });
        return {
            success: true,
            audit: finalAudit,
            message: `${formatAuditReport(finalAudit)}\n\n[Dry Run] Grace countdown would run for ${delay}s (force: ${force}).\n${dryRes.message}`
        };
    }

    if (process.platform !== 'win32') {
        return {
            success: false,
            audit: finalAudit,
            message: `Unsupported platform "${process.platform}". agent-zzz v0.1 currently supports Windows.`
        };
    }

    // Execute grace countdown
    await runGraceCountdown(delay, mode, logFn);

    // Write durable pre-sleep state latch
    state.writeStateLatch({
        hibernate: !!options.hibernate,
        invokingSessionId: finalAudit.excludedSessionId
    }, options);

    logFn(`[${formatLocalTimestamp(new Date(), true)}] Triggering OS ${mode} now...`);

    // Trigger OS sleep
    const suspendRes = power.executeSuspend(options);

    // Upon system resume, update state latch
    if (suspendRes.success) {
        state.markResumed(options);
    }

    return {
        ...suspendRes,
        message: `[${formatLocalTimestamp(new Date(), true)}] ${suspendRes.message}`,
        audit: finalAudit
    };
}

module.exports = {
    formatLocalTimestamp,
    sleepAsync,
    checkStatus,
    formatAuditReport,
    waitForIdle,
    runGraceCountdown,
    sleepSystem,
    telemetry,
    power,
    state
};
