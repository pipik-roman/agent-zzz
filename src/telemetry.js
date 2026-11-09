const fs = require('fs');
const path = require('path');
const os = require('os');

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
        const buffer = Buffer.alloc(bufferSize);
        const fd = fs.openSync(filePath, 'r');
        try {
            fs.readSync(fd, buffer, 0, bufferSize, stat.size - bufferSize);
        } finally {
            fs.closeSync(fd);
        }
        const text = buffer.toString('utf8');
        const lines = text.trim().split(/\r?\n/);
        return lines[lines.length - 1] || '';
    } catch (e) {
        return '';
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
                    if (reqMatch) cleaned = reqMatch[1];
                    cleaned = cleaned.replace(/<[^>]+>/g, ' ').replace(/[*_#`]+/g, ' ').replace(/[\r\n\t]+/g, ' ').trim();
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
    const now = Date.now();
    const maxAgeSec = typeof options.maxTranscriptAgeSec === 'number' ? options.maxTranscriptAgeSec : 900;

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const convId = entry.name;

        // Deterministic self-exclusion
        if (excludedId && convId === excludedId) continue;

        const transcriptPath = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
        if (!fs.existsSync(transcriptPath)) continue;

        try {
            const stat = fs.statSync(transcriptPath);
            const ageSec = Math.round((now - stat.mtimeMs) / 1000);

            if (ageSec > maxAgeSec) continue;

            const lastLine = getLastLine(transcriptPath);
            if (!lastLine) continue;

            let parsed;
            try {
                parsed = JSON.parse(lastLine);
            } catch (e) {
                continue;
            }

            const isToolRunning = parsed.type === 'PLANNER_RESPONSE' && Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0;
            const isModelThinking = parsed.type === 'GENERIC' || parsed.source === 'USER_EXPLICIT';
            const isRunningStatus = parsed.status === 'RUNNING';
            const isRecentTouch = ageSec < 15;

            if (isToolRunning || isModelThinking || isRunningStatus || isRecentTouch) {
                const topic = extractSessionTopic(transcriptPath);
                let toolName = null;
                if (isToolRunning && parsed.tool_calls[0] && parsed.tool_calls[0].name) {
                    toolName = parsed.tool_calls[0].name;
                }

                let state = 'processing';
                if (isToolRunning) {
                    state = `running tool "${toolName}"`;
                } else if (isModelThinking) {
                    state = 'model generating response';
                } else if (isRecentTouch) {
                    state = 'active turn in progress';
                }

                activeSessions.push({
                    harness: 'antigravity',
                    id: convId,
                    shortId: convId.slice(0, 8),
                    step: parsed.step_index || 0,
                    ageSec,
                    state,
                    tool: toolName,
                    topic
                });
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
    getLastLine,
    extractSessionTopic,
    resolveExcludedSessionId,
    findActiveAntigravitySessions,
    findActiveSessions
};
