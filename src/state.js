const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Resolves the path to the durable state latch file.
 * Keeps user terminals and sandboxed agent shells aligned on the same default latch path.
 * @param {Object} options
 * @returns {string}
 */
function getStateLatchPath(options = {}) {
    if (options.stateFile) return path.resolve(options.stateFile);
    if (process.env.AGENT_ZZZ_STATE_FILE) return path.resolve(process.env.AGENT_ZZZ_STATE_FILE);
    if (options.appDataDir) return path.join(options.appDataDir, 'power-pause.json');
    return path.join(os.homedir(), '.gemini', 'agent-zzz', 'power-pause.json');
}

/**
 * Writes a durable pre-sleep marker before triggering OS suspension.
 * Allows harnesses to differentiate intentional sleep from unexpected crashes on resume.
 * @param {Object} payload
 * @param {Object} options
 * @returns {{ written: boolean, path: string, data?: Object, error?: string }}
 */
function writeStateLatch(payload = {}, options = {}) {
    const latchPath = getStateLatchPath(options);
    const data = {
        source: 'agent-zzz',
        action: payload.hibernate ? 'hibernate' : 'suspend',
        invokingSessionId: payload.invokingSessionId || process.env.ANTIGRAVITY_CONVERSATION_ID || null,
        timestamp: new Date().toISOString(),
        resumed: false,
        resumedAt: null
    };

    try {
        fs.mkdirSync(path.dirname(latchPath), { recursive: true });
        fs.writeFileSync(latchPath, JSON.stringify(data, null, 2), 'utf8');
        return { written: true, path: latchPath, data };
    } catch (err) {
        return { written: false, path: latchPath, error: err.message };
    }
}

/**
 * Updates the durable state latch marker after the OS resumes from sleep.
 * @param {Object} options
 * @returns {{ updated: boolean, path: string, error?: string }}
 */
function markResumed(options = {}) {
    const latchPath = getStateLatchPath(options);
    try {
        if (!fs.existsSync(latchPath)) {
            return { updated: false, path: latchPath, error: 'State latch not found' };
        }
        const raw = fs.readFileSync(latchPath, 'utf8');
        const data = JSON.parse(raw);
        data.resumed = true;
        data.resumedAt = new Date().toISOString();
        fs.writeFileSync(latchPath, JSON.stringify(data, null, 2), 'utf8');
        return { updated: true, path: latchPath, data };
    } catch (err) {
        return { updated: false, path: latchPath, error: err.message };
    }
}

/**
 * Reads the last durable state latch marker.
 * @param {Object} options
 * @returns {Object|null}
 */
function readStateLatch(options = {}) {
    const latchPath = getStateLatchPath(options);
    try {
        if (!fs.existsSync(latchPath)) return null;
        return JSON.parse(fs.readFileSync(latchPath, 'utf8'));
    } catch (err) {
        return null;
    }
}

module.exports = {
    getStateLatchPath,
    writeStateLatch,
    markResumed,
    readStateLatch
};
