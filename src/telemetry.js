const fs = require('fs');
const path = require('path');
const os = require('os');

const PASSIVE_TIMER_REGEX = /^(?:Timer|Cron|Schedule)\s*:/i;
const TASK_START_ID_REGEX = /^Tool is running as a background task with task id:\s*([^\s\r\n]+)/im;
const TASK_DESCRIPTION_REGEX = /^Task Description:\s*([^\r\n]+)/im;
const TASK_LOG_PATH_REGEX = /^Task logs are available at:\s*[^\r\n]*[/\\]([^/\r\n]+\.log)/im;
const TASK_FINISHED_REGEX = /Task id\s+["']?([^\s"']+)["']?\s+(?:finished|completed|failed|cancelled|canceled|killed|exited|stopped)\b/gi;
const MANAGE_TASK_TERMINAL_REGEX = /^Task:\s*([^\s\r\n]+)\r?\nStatus:\s*(DONE|COMPLETED|FINISHED|KILLED|CANCELL?ED|FAILED|ERROR)\b/gim;

/**
 * Parses an ISO timestamp string into epoch milliseconds, returning null if invalid.
 * @param {string} value
 * @returns {number|null}
 */
function parseTimestampMs(value) {
    if (typeof value !== 'string' || !value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * Reads the last non-empty line of a file efficiently without loading the full file.
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {string}
 */
function getLastLine(filePath, maxBytes = 8192) {
    try {
        const stat = fs.statSync(filePath);
        if (stat.size === 0) return '';
        const bufferSize = Math.min(maxBytes, stat.size);
        const startOffset = stat.size - bufferSize;
        const buffer = Buffer.alloc(bufferSize);
        const fd = fs.openSync(filePath, 'r');
        try {
            fs.readSync(fd, buffer, 0, bufferSize, startOffset);
        } finally {
            fs.closeSync(fd);
        }
        let text = buffer.toString('utf8');
        if (startOffset > 0) {
            const firstNewline = text.indexOf('\n');
            if (firstNewline >= 0) {
                text = text.slice(firstNewline + 1);
            }
        }
        const lines = text.trim().split(/\r?\n/);
        return lines[lines.length - 1] || '';
    } catch (e) {
        return '';
    }
}

/**
 * Reads and parses trailing JSONL transcript entries efficiently without loading the full file.
 * Automatically discards any partial leading line when reading from a byte offset > 0.
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {{ entries: Array<Object>, truncated: boolean }}
 */
function getTailEntries(filePath, maxBytes = 262144) {
    try {
        const stat = fs.statSync(filePath);
        if (stat.size === 0) return { entries: [], truncated: false };

        let targetBytes = Math.min(maxBytes, stat.size);
        let text = '';
        let startOffset = stat.size - targetBytes;

        for (let attempt = 0; attempt < 2; attempt++) {
            const buffer = Buffer.alloc(targetBytes);
            const fd = fs.openSync(filePath, 'r');
            try {
                fs.readSync(fd, buffer, 0, targetBytes, startOffset);
            } finally {
                fs.closeSync(fd);
            }
            text = buffer.toString('utf8');
            if (startOffset === 0) break;

            const firstNewline = text.indexOf('\n');
            if (firstNewline >= 0) {
                text = text.slice(firstNewline + 1);
                break;
            }

            // Single very large final line: expand window once up to 1MB
            const expanded = Math.min(stat.size, targetBytes * 4);
            if (expanded === targetBytes) break;
            targetBytes = expanded;
            startOffset = stat.size - targetBytes;
        }

        const entries = [];
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                entries.push(JSON.parse(trimmed));
            } catch (e) {
                // Skip malformed JSON line
            }
        }

        return {
            entries,
            truncated: startOffset > 0
        };
    } catch (e) {
        return { entries: [], truncated: false };
    }
}

/**
 * Extracts a concise session topic from the opening lines of a transcript.
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {string}
 */
function extractSessionTopic(filePath, maxBytes = 8192) {
    try {
        const stat = fs.statSync(filePath);
        if (stat.size === 0) return 'Empty chat session';
        const bufferSize = Math.min(maxBytes, stat.size);
        const buffer = Buffer.alloc(bufferSize);
        const fd = fs.openSync(filePath, 'r');
        let bytesRead = 0;
        try {
            bytesRead = fs.readSync(fd, buffer, 0, bufferSize, 0);
        } finally {
            fs.closeSync(fd);
        }
        const text = buffer.toString('utf8', 0, bytesRead);
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const item = JSON.parse(line);
                if (item.content && (item.type === 'USER_INPUT' || item.source === 'USER_EXPLICIT' || item.type === 'SYSTEM_MESSAGE')) {
                    let cleaned = item.content;
                    const reqMatch = cleaned.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
                    if (reqMatch) {
                        cleaned = reqMatch[1];
                    } else if (item.type === 'SYSTEM_MESSAGE' && /\[Message\][\s\S]*?\bcontent=/i.test(cleaned)) {
                        const sysMatch = cleaned.match(/\[Message\][\s\S]*?\bcontent=([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/i);
                        if (sysMatch) cleaned = sysMatch[1];
                    }
                    cleaned = cleaned
                        .replace(/<[^>]+>/g, ' ')
                        .replace(/[*_#`]+/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                    if (cleaned.length > 5) {
                        return cleaned.slice(0, 65);
                    }
                }
            } catch (e) {
                // Ignore malformed JSON line
            }
        }
    } catch (e) {
        // Ignore read error
    }
    return 'Antigravity Chat Session';
}

/**
 * Checks whether a transcript entry represents a passive schedule/timer wait rather than active execution.
 * @param {Object} entry
 * @returns {boolean}
 */
function isPassiveTimerEntry(entry) {
    if (!entry || typeof entry.content !== 'string') return false;
    const descMatch = entry.content.match(TASK_DESCRIPTION_REGEX);
    return !!(descMatch && PASSIVE_TIMER_REGEX.test(descMatch[1].trim()));
}

/**
 * Checks whether a task ID belongs to the given conversation session.
 * Rejects task IDs embedded inside read_file transcripts from other sessions.
 * @param {string} taskId
 * @param {string} [convId]
 * @returns {boolean}
 */
function belongsToConversation(taskId, convId) {
    if (!taskId) return false;
    if (!convId || !taskId.includes('/')) return true;
    const prefix = taskId.split('/')[0];
    return prefix === convId;
}

/**
 * Tracks open and completed background tasks across trailing transcript entries.
 * Passive Timer/Cron schedules are separated so long standing crons do not veto OS sleep.
 * @param {Array<Object>} entries
 * @param {number} fallbackTimestampMs
 * @param {string} [convId]
 * @returns {{ openTasks: Map<string, Object>, completedTasks: Map<string, Object>, completedByLog: Map<string, number>, passiveTimerLogs: Set<string> }}
 */
function extractBackgroundTaskState(entries, fallbackTimestampMs, convId = '') {
    const openTasks = new Map();
    const completedTasks = new Map();
    const completedByLog = new Map();
    const passiveTimerIds = new Set();
    const passiveTimerLogs = new Set();

    for (const entry of entries) {
        const content = typeof entry.content === 'string' ? entry.content : '';
        if (!content) continue;

        const entryMs = parseTimestampMs(entry.created_at) ?? fallbackTimestampMs;

        // 1. Detect background task launch (must be a RUNNING GENERIC tool result belonging to this session)
        const startMatch = (entry.type === 'GENERIC' && entry.status === 'RUNNING')
            ? content.match(TASK_START_ID_REGEX)
            : null;
        if (startMatch && belongsToConversation(startMatch[1], convId)) {
            const taskId = startMatch[1];
            const shortId = taskId.includes('/') ? taskId.split('/').pop() : taskId;
            const descMatch = content.match(TASK_DESCRIPTION_REGEX);
            const description = descMatch ? descMatch[1].trim() : '';
            const logMatch = content.match(TASK_LOG_PATH_REGEX);
            const logFile = logMatch ? logMatch[1] : `${shortId}.log`;

            if (PASSIVE_TIMER_REGEX.test(description)) {
                passiveTimerIds.add(taskId);
                passiveTimerLogs.add(logFile);
            } else {
                openTasks.set(taskId, {
                    id: taskId,
                    shortId,
                    description,
                    logFile,
                    createdAtMs: entryMs
                });
            }
        }

        // 2. Detect completion via SYSTEM_MESSAGE notification
        TASK_FINISHED_REGEX.lastIndex = 0;
        let finishMatch;
        while ((finishMatch = TASK_FINISHED_REGEX.exec(content)) !== null) {
            const closedId = finishMatch[1];
            if (!belongsToConversation(closedId, convId)) continue;

            const existing = openTasks.get(closedId);
            const shortId = closedId.includes('/') ? closedId.split('/').pop() : closedId;
            const logFile = existing ? existing.logFile : `${shortId}.log`;

            openTasks.delete(closedId);
            if (!passiveTimerIds.has(closedId)) {
                completedTasks.set(closedId, { id: closedId, logFile, completedAtMs: entryMs });
                completedByLog.set(logFile, Math.max(completedByLog.get(logFile) || 0, entryMs));
            }
        }

        // 3. Detect terminal status via manage_task status/kill output
        MANAGE_TASK_TERMINAL_REGEX.lastIndex = 0;
        let manageMatch;
        while ((manageMatch = MANAGE_TASK_TERMINAL_REGEX.exec(content)) !== null) {
            const closedId = manageMatch[1];
            if (!belongsToConversation(closedId, convId)) continue;

            const existing = openTasks.get(closedId);
            const shortId = closedId.includes('/') ? closedId.split('/').pop() : closedId;
            const logFile = existing ? existing.logFile : `${shortId}.log`;

            openTasks.delete(closedId);
            if (!passiveTimerIds.has(closedId)) {
                completedTasks.set(closedId, { id: closedId, logFile, completedAtMs: entryMs });
                completedByLog.set(logFile, Math.max(completedByLog.get(logFile) || 0, entryMs));
            }
        }
    }

    return {
        openTasks,
        completedTasks,
        completedByLog,
        passiveTimerLogs
    };
}

/**
 * Reads `.system_generated/tasks/*.log` metadata for a session directory.
 * @param {string} tasksDir
 * @returns {Array<{ fileName: string, mtimeMs: number }>}
 */
function readTaskLogFiles(tasksDir) {
    if (!fs.existsSync(tasksDir)) return [];
    const logs = [];
    try {
        const items = fs.readdirSync(tasksDir, { withFileTypes: true });
        for (const item of items) {
            if (!item.isFile() || !item.name.toLowerCase().endsWith('.log')) continue;
            try {
                const stat = fs.statSync(path.join(tasksDir, item.name));
                logs.push({ fileName: item.name, mtimeMs: stat.mtimeMs });
            } catch (e) {
                // Skip unreadable log
            }
        }
    } catch (e) {
        return [];
    }
    return logs;
}

/**
 * Evaluates whether a single Antigravity conversation is currently active.
 * Accounts for synchronous tool calls, open background tasks, live `.log` output,
 * context compaction checkpoints, pre-response model generation, and turn handoff buffers.
 * @param {Object} params
 * @param {string} params.convId
 * @param {string} params.transcriptPath
 * @param {string} params.tasksDir
 * @param {Object} [params.options]
 * @returns {Object|null}
 */
function inspectAntigravitySession({ convId, transcriptPath, tasksDir, options = {} }) {
    const now = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
    const maxAgeSec = typeof options.maxTranscriptAgeSec === 'number' ? options.maxTranscriptAgeSec : 900;
    const maxThinkingAgeSec = typeof options.maxThinkingAgeSec === 'number' ? options.maxThinkingAgeSec : 300;
    const maxBackgroundTaskAgeSec = typeof options.maxBackgroundTaskAgeSec === 'number' ? options.maxBackgroundTaskAgeSec : 1800;
    const recentTaskLogSec = typeof options.recentTaskLogSec === 'number' ? options.recentTaskLogSec : 30;
    const recentTouchSec = typeof options.recentTouchSec === 'number' ? options.recentTouchSec : 15;
    const maxTailBytes = typeof options.maxTailBytes === 'number' ? options.maxTailBytes : 262144;

    const stat = fs.statSync(transcriptPath);
    const transcriptAgeSec = Math.max(0, Math.round((now - stat.mtimeMs) / 1000));

    // Fast skip for historical sessions older than 24h
    if (transcriptAgeSec > 86400) return null;

    const taskLogFiles = readTaskLogFiles(tasksDir);
    const hasFreshAnyLog = taskLogFiles.some((f) => Math.max(0, Math.round((now - f.mtimeMs) / 1000)) <= recentTaskLogSec);
    const maxOverallAgeSec = Math.max(maxAgeSec, maxBackgroundTaskAgeSec);

    if (transcriptAgeSec > maxOverallAgeSec && !hasFreshAnyLog) {
        return null;
    }

    const { entries } = getTailEntries(transcriptPath, maxTailBytes);
    if (entries.length === 0) return null;

    const last = entries[entries.length - 1];
    const taskState = extractBackgroundTaskState(entries, stat.mtimeMs, convId);

    const logMtimeByName = new Map();
    const activeTaskLogs = [];
    for (const logFile of taskLogFiles) {
        logMtimeByName.set(logFile.fileName, logFile.mtimeMs);

        if (taskState.passiveTimerLogs.has(logFile.fileName)) continue;

        const completedAtMs = taskState.completedByLog.get(logFile.fileName);
        if (completedAtMs !== undefined && logFile.mtimeMs <= completedAtMs + 5000) {
            continue;
        }

        const logAgeSec = Math.max(0, Math.round((now - logFile.mtimeMs) / 1000));
        if (logAgeSec <= recentTaskLogSec) {
            activeTaskLogs.push({ fileName: logFile.fileName, ageSec: logAgeSec });
        }
    }
    activeTaskLogs.sort((a, b) => a.ageSec - b.ageSec);

    const activeOpenTasks = [];
    for (const task of taskState.openTasks.values()) {
        const taskAgeSec = Math.max(0, Math.round((now - task.createdAtMs) / 1000));
        const logMtimeMs = logMtimeByName.get(task.logFile);
        const logAgeSec = logMtimeMs !== undefined ? Math.max(0, Math.round((now - logMtimeMs) / 1000)) : null;

        if (taskAgeSec <= maxBackgroundTaskAgeSec || (logAgeSec !== null && logAgeSec <= recentTaskLogSec)) {
            activeOpenTasks.push({
                ...task,
                taskAgeSec,
                logAgeSec
            });
        }
    }

    const isPassiveLastTimer = isPassiveTimerEntry(last);
    const isToolRunning = last.type === 'PLANNER_RESPONSE'
        && Array.isArray(last.tool_calls)
        && last.tool_calls.length > 0
        && transcriptAgeSec <= maxAgeSec;
    const isRunningStatus = last.status === 'RUNNING'
        && (!isPassiveLastTimer || transcriptAgeSec < recentTouchSec)
        && transcriptAgeSec <= maxAgeSec;
    const hasOpenBackgroundTask = activeOpenTasks.length > 0;
    const hasActiveTaskLog = activeTaskLogs.length > 0;
    const isAwaitingModelResponse = (
        last.type === 'GENERIC'
        || last.type === 'SYSTEM_MESSAGE'
        || last.type === 'CHECKPOINT'
        || last.type === 'USER_INPUT'
        || last.source === 'USER_EXPLICIT'
    )
        && !(last.type === 'GENERIC' && isPassiveLastTimer)
        && transcriptAgeSec <= maxThinkingAgeSec;
    const isRecentTouch = transcriptAgeSec < recentTouchSec;

    if (!isToolRunning && !isRunningStatus && !hasOpenBackgroundTask && !hasActiveTaskLog && !isAwaitingModelResponse && !isRecentTouch) {
        return null;
    }

    const topic = extractSessionTopic(transcriptPath);
    let toolName = null;
    if (isToolRunning && last.tool_calls[0] && last.tool_calls[0].name) {
        toolName = last.tool_calls[0].name;
    }

    let state = 'processing';
    if (isToolRunning) {
        state = `running tool "${toolName}"`;
    } else if (hasOpenBackgroundTask) {
        const latestTask = activeOpenTasks[activeOpenTasks.length - 1];
        state = `running background task "${latestTask.shortId}"`;
    } else if (hasActiveTaskLog) {
        state = `active task log "${activeTaskLogs[0].fileName}"`;
    } else if (isRunningStatus) {
        state = 'active operation in progress';
    } else if (isAwaitingModelResponse) {
        state = last.type === 'CHECKPOINT'
            ? 'resuming after compaction'
            : 'model generating response';
    } else if (isRecentTouch) {
        state = 'active turn in progress';
    }

    let ageSec = transcriptAgeSec;
    let lastActivityMs = stat.mtimeMs;
    if (activeTaskLogs.length > 0) {
        ageSec = Math.min(ageSec, activeTaskLogs[0].ageSec);
        const topLogMs = logMtimeByName.get(activeTaskLogs[0].fileName);
        if (topLogMs && topLogMs > lastActivityMs) {
            lastActivityMs = topLogMs;
        }
    }
    for (const t of activeOpenTasks) {
        if (t.logAgeSec !== null) {
            ageSec = Math.min(ageSec, t.logAgeSec);
            const taskLogMs = logMtimeByName.get(t.logFile);
            if (taskLogMs && taskLogMs > lastActivityMs) {
                lastActivityMs = taskLogMs;
            }
        }
    }

    return {
        harness: 'antigravity',
        id: convId,
        shortId: convId.slice(0, 8),
        step: last.step_index || 0,
        ageSec,
        lastActivityAt: new Date(lastActivityMs).toISOString(),
        state,
        tool: toolName,
        topic
    };
}

/**
 * Resolves the self-exclusion ID for the current active session.
 * Prevents self-deadlock where the invoking agent detects its own active turn.
 * @param {Object} options
 * @returns {string}
 */
function resolveExcludedSessionId(options = {}) {
    return (
        options.excludeSession ||
        options.currentConversationId ||
        process.env.AGENT_ZZZ_EXCLUDE_SESSION ||
        process.env.ANTIGRAVITY_CONVERSATION_ID ||
        ''
    );
}

/**
 * Scans Google Antigravity brain transcripts for actively executing sessions.
 * @param {Object} options
 * @returns {Array<Object>}
 */
function findActiveAntigravitySessions(options = {}) {
    const appDataDir = options.appDataDir || process.env.ANTIGRAVITY_APP_DATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity');
    const brainDir = path.join(appDataDir, 'brain');
    const excludedId = resolveExcludedSessionId(options);

    if (!fs.existsSync(brainDir)) return [];

    let entries = [];
    try {
        entries = fs.readdirSync(brainDir, { withFileTypes: true });
    } catch (e) {
        return [];
    }

    const activeSessions = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const convId = entry.name;

        // Deterministic self-exclusion
        if (excludedId && convId === excludedId) continue;

        const transcriptPath = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
        if (!fs.existsSync(transcriptPath)) continue;

        const tasksDir = path.join(brainDir, convId, '.system_generated', 'tasks');

        try {
            const session = inspectAntigravitySession({
                convId,
                transcriptPath,
                tasksDir,
                options
            });
            if (session) {
                activeSessions.push(session);
            }
        } catch (e) {
            // Skip unreadable transcript
        }
    }

    return activeSessions;
}

/**
 * Aggregates active agent sessions across supported telemetry adapters.
 * v0.1 focuses on Antigravity; modularized for Claude Code / Cursor / Crush in v0.2+.
 * @param {Object} options
 * @returns {Array<Object>}
 */
function findActiveSessions(options = {}) {
    const adapters = [findActiveAntigravitySessions];
    let results = [];
    for (const adapter of adapters) {
        results = results.concat(adapter(options));
    }
    return results;
}

module.exports = {
    parseTimestampMs,
    getLastLine,
    getTailEntries,
    extractSessionTopic,
    isPassiveTimerEntry,
    belongsToConversation,
    extractBackgroundTaskState,
    readTaskLogFiles,
    inspectAntigravitySession,
    resolveExcludedSessionId,
    findActiveAntigravitySessions,
    findActiveSessions
};
