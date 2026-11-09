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
    const diagnostics = { permissionDeniedCount: 0, unreadableCount: 0 };
    const activeSessions = telemetry.findActiveSessions({ ...options, _diagnostics: diagnostics });
    const permissionDeniedCount = diagnostics.permissionDeniedCount || 0;
    const telemetryBlocked = permissionDeniedCount > 0;
    const sleepStates = power.getAvailableSleepStates();
    const powerAudit = power.auditPowerRequests();
    const lastLatch = state.readStateLatch(options);

    return {
        checkedAt: new Date().toISOString(),
        readyToSleep: activeSessions.length === 0 && !telemetryBlocked,
        telemetryBlocked,
        unreadableSessions: permissionDeniedCount,
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

    if (audit.telemetryBlocked) {
        lines.push(`Agent sessions: TELEMETRY BLOCKED — ${audit.unreadableSessions} external session(s) could not be read (EPERM/EACCES, likely sandbox isolation).`);
        lines.push('  Run outside the sandbox (BypassSandbox: true) to audit sibling sessions, or pass --now to bypass telemetry.');
        if (audit.activeSessions.length > 0) {
            lines.push(`  Readable active session(s) detected: ${audit.activeSessions.length}`);
            for (const s of audit.activeSessions) {
                const atTime = s.lastActivityAt ? ` @ ${formatLocalTimestamp(s.lastActivityAt)}` : '';
                lines.push(`  - [${s.harness}:${s.shortId}] "${s.topic}" (step ${s.step}, ${s.state}, ${s.ageSec}s ago${atTime})`);
            }
        }
    } else if (audit.activeSessions.length === 0) {
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
 * When `options.monitorActivity` is true, continuously polls external agent telemetry
 * during the countdown and interrupts early if an external session wakes up or resumes.
 * @param {number} delaySeconds
 * @param {string} mode
 * @param {Function} [logFn]
 * @param {Object} [options]
 * @returns {Promise<{ completed: boolean, interrupted: boolean, activeSessions: Array<Object>, remainingSec?: number }>}
 */
async function runGraceCountdown(delaySeconds, mode, logFn = console.log, options = {}) {
    if (delaySeconds <= 0) {
        return { completed: true, interrupted: false, activeSessions: [] };
    }

    logFn(`\n[${formatLocalTimestamp(new Date(), true)}] System will enter ${mode} in ${delaySeconds} second(s). Press Ctrl+C to abort.`);

    const stepFor = (rem) => (rem > 10 ? 10 : (rem > 5 ? 5 : 1));
    const monitorActivity = !!options.monitorActivity;
    const pollSliceSec = monitorActivity
        ? (typeof options.countdownPollSeconds === 'number' && options.countdownPollSeconds > 0
            ? options.countdownPollSeconds
            : (typeof options.pollIntervalSeconds === 'number' && options.pollIntervalSeconds > 0 && options.pollIntervalSeconds < 2
                ? options.pollIntervalSeconds
                : 2))
        : delaySeconds;

    let remaining = delaySeconds;
    let nextLogRemaining = Math.max(0, Number((delaySeconds - stepFor(delaySeconds)).toFixed(6)));

    while (remaining > 0) {
        const untilMilestone = Math.max(0, Number((remaining - nextLogRemaining).toFixed(6)));
        const waitSec = monitorActivity
            ? Math.min(pollSliceSec, untilMilestone > 0 ? untilMilestone : remaining, remaining)
            : Math.min(stepFor(remaining), remaining);

        await sleepAsync(waitSec * 1000);
        remaining = Math.max(0, Number((remaining - waitSec).toFixed(6)));

        if (monitorActivity) {
            const active = telemetry.findActiveSessions(options);
            if (active.length > 0) {
                return {
                    completed: false,
                    interrupted: true,
                    activeSessions: active,
                    remainingSec: Math.ceil(remaining)
                };
            }
        }

        if (remaining > 0 && (!monitorActivity || remaining <= nextLogRemaining + 1e-6)) {
            logFn(`  [${formatLocalTimestamp()}] ... ${Math.ceil(remaining)}s remaining before ${mode}`);
            nextLogRemaining = Math.max(0, Number((remaining - stepFor(remaining)).toFixed(6)));
        }
    }

    return { completed: true, interrupted: false, activeSessions: [] };
}

/**
 * Orchestrates the complete pre-flight audit, wait latch, live-monitored countdown, and OS power transition.
 * If an external agent wakes up or receives user confirmation during the grace countdown,
 * the countdown pauses automatically and re-enters the idle-wait monitor.
 * @param {Object} options
 * @returns {Promise<{ success: boolean, message: string, audit?: Object }>}
 */
async function sleepSystem(options = {}) {
    const logFn = options.logFn || console.log;
    const delay = typeof options.delay === 'number' ? options.delay : 30;
    const mode = options.hibernate ? 'hibernate' : 'sleep';
    const force = options.force !== false;
    const suspendFn = options.executeSuspendFn || power.executeSuspend;
    const platform = options.platform || process.platform;

    const initialAudit = checkStatus(options);

    // Check-only mode (fails closed if sandbox/permissions blocked external session telemetry)
    if (options.checkOnly) {
        return {
            success: !initialAudit.telemetryBlocked,
            audit: initialAudit,
            message: formatAuditReport(initialAudit)
        };
    }

    // Refuse to sleep blindly when external telemetry cannot be read unless --now is explicitly requested
    if (initialAudit.telemetryBlocked && options.waitIdle !== false) {
        return {
            success: false,
            audit: initialAudit,
            message: `[${formatLocalTimestamp(new Date(), true)}] Aborted: cannot verify external agent sessions (${initialAudit.unreadableSessions} session(s) returned EPERM/EACCES, likely sandbox isolation). Re-run outside the sandbox (BypassSandbox: true) or pass --now to sleep without telemetry.`
        };
    }

    const startWaitMs = Date.now();
    const baseTimeoutMin = typeof options.timeoutMinutes === 'number' ? options.timeoutMinutes : 30;
    let finalAudit = initialAudit;
    let warnedPowerLocks = false;

    while (true) {
        // Wait for concurrent sessions unless bypassed (--now)
        if (options.waitIdle !== false) {
            let waitOpts = options;
            if (baseTimeoutMin > 0) {
                const elapsedMin = (Date.now() - startWaitMs) / 60000;
                const remainingMin = baseTimeoutMin - elapsedMin;
                if (remainingMin <= 0) {
                    return {
                        success: false,
                        audit: finalAudit,
                        message: `[${formatLocalTimestamp(new Date(), true)}] Timed out after ${baseTimeoutMin}m waiting for active session(s) to finish.`
                    };
                }
                waitOpts = { ...options, timeoutMinutes: remainingMin };
            }

            const waitRes = await waitForIdle(waitOpts, logFn);
            if (!waitRes.ready) {
                return {
                    success: false,
                    audit: finalAudit,
                    message: waitRes.message
                };
            }
        }

        // Refresh OS power lock audit and telemetry readability after sessions settle
        finalAudit = checkStatus(options);
        if (finalAudit.telemetryBlocked && options.waitIdle !== false) {
            return {
                success: false,
                audit: finalAudit,
                message: `[${formatLocalTimestamp(new Date(), true)}] Aborted: telemetry lost access to ${finalAudit.unreadableSessions} external session(s) (EPERM/EACCES). Re-run outside the sandbox (BypassSandbox: true) or pass --now to force sleep.`
            };
        }
        if (finalAudit.powerAudit && finalAudit.powerAudit.locks.length > 0) {
            if (!warnedPowerLocks) {
                logFn(`\n[${formatLocalTimestamp()}] Warning: ${finalAudit.powerAudit.message}`);
                for (const lock of finalAudit.powerAudit.locks) {
                    logFn(`  - [${lock.category}] ${lock.entry}`);
                }
                if (force) {
                    logFn('Smart Force enabled: proceeding with requested sleep (pass --no-force to respect OS locks).');
                }
                warnedPowerLocks = true;
            }
            if (!force) {
                return {
                    success: false,
                    audit: finalAudit,
                    message: `[${formatLocalTimestamp(new Date(), true)}] Sleep aborted due to active OS wake locks (--no-force specified).`
                };
            }
        }

        // Dry-run mode
        if (options.dryRun) {
            const dryRes = suspendFn({ ...options, dryRun: true });
            return {
                success: true,
                audit: finalAudit,
                message: `${formatAuditReport(finalAudit)}\n\n[Dry Run] Grace countdown would run for ${delay}s (force: ${force}).\n${dryRes.message}`
            };
        }

        if (platform !== 'win32') {
            return {
                success: false,
                audit: finalAudit,
                message: `Unsupported platform "${platform}". agent-zzz v0.1 currently supports Windows.`
            };
        }

        // Execute grace countdown while continuously re-checking external agent telemetry (unless --now)
        const countdownRes = await runGraceCountdown(delay, mode, logFn, {
            ...options,
            monitorActivity: options.waitIdle !== false
        });

        if (countdownRes && countdownRes.interrupted) {
            logFn(`\n[${formatLocalTimestamp(new Date(), true)}] Sleep countdown paused: external agent session resumed:`);
            for (const s of countdownRes.activeSessions) {
                const atTime = s.lastActivityAt ? ` @ ${formatLocalTimestamp(s.lastActivityAt)}` : '';
                logFn(`  - [${s.harness}:${s.shortId}] "${s.topic}" (step ${s.step}, ${s.state}, active ${s.ageSec}s ago${atTime})`);
            }
            logFn('Returning to active-session monitor...\n');
            continue;
        }

        break;
    }

    // Write durable pre-sleep state latch
    state.writeStateLatch({
        hibernate: !!options.hibernate,
        invokingSessionId: finalAudit.excludedSessionId
    }, options);

    logFn(`[${formatLocalTimestamp(new Date(), true)}] Triggering OS ${mode} now...`);

    // Trigger OS sleep
    const suspendRes = suspendFn(options);

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
