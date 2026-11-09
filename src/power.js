const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Resolves a Windows System32 executable path explicitly so current-working-directory
 * binary planting cannot shadow trusted system tools (`powercfg.exe`, `powershell.exe`).
 * @param {string[]} subPathSegments
 * @param {string} fallbackExe
 * @returns {string}
 */
function resolveWindowsSystemExe(subPathSegments, fallbackExe) {
    if (process.platform !== 'win32') return fallbackExe;
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const candidate = path.join(systemRoot, 'System32', ...subPathSegments);
    return fs.existsSync(candidate) ? candidate : fallbackExe;
}

/**
 * Builds the hardened PowerShell CLR command to trigger Windows Standby or Hibernate.
 * Strictly avoids rundll32.exe powrprof.dll ABI mismatch bugs.
 * @param {Object} options
 * @returns {string}
 */
function buildWindowsSuspendCommand(options = {}) {
    const powerState = options.hibernate
        ? '[System.Windows.Forms.PowerState]::Hibernate'
        : '[System.Windows.Forms.PowerState]::Suspend';
    const force = options.force !== false ? '$true' : '$false';
    const disableWake = options.disableWake ? '$true' : '$false';

    return `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState(${powerState}, ${force}, ${disableWake})`;
}

/**
 * Queries supported firmware sleep states via `powercfg /availablesleepstates`.
 * Works without elevated Administrator privileges on Windows.
 * @returns {{ available: boolean, states: string[], raw?: string, error?: string }}
 */
function getAvailableSleepStates() {
    if (process.platform !== 'win32') {
        return { available: false, states: [], error: `Unsupported platform: ${process.platform}` };
    }

    const powercfgExe = resolveWindowsSystemExe(['powercfg.exe'], 'powercfg');
    const res = spawnSync(powercfgExe, ['/availablesleepstates'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    if (res.error || res.status !== 0) {
        return {
            available: false,
            states: [],
            error: res.error ? res.error.message : (res.stderr || res.stdout || '').trim()
        };
    }

    const output = res.stdout || '';
    const states = [];
    const lines = output.split(/\r?\n/);
    let inAvailableSection = false;

    for (const line of lines) {
        const trimmed = line.trim();
        if (/following sleep states are available/i.test(trimmed)) {
            inAvailableSection = true;
            continue;
        }
        if (/following sleep states are not available/i.test(trimmed)) {
            inAvailableSection = false;
            continue;
        }
        if (inAvailableSection && trimmed) {
            states.push(trimmed);
        }
    }

    return { available: true, states, raw: output };
}

/**
 * Parses `powercfg /requests` output to detect active OS wake locks.
 * Gracefully reports elevation boundaries if run in a standard non-admin session.
 * @returns {{ audited: boolean, elevated: boolean, locks: Array<{ category: string, entry: string }>, message: string }}
 */
function auditPowerRequests() {
    if (process.platform !== 'win32') {
        return {
            audited: false,
            elevated: false,
            locks: [],
            message: `OS lock auditing not yet supported on ${process.platform}.`
        };
    }

    const powercfgExe = resolveWindowsSystemExe(['powercfg.exe'], 'powercfg');
    const res = spawnSync(powercfgExe, ['/requests'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    const combined = `${res.stdout || ''}\n${res.stderr || ''}`.trim();

    if (res.error) {
        return {
            audited: false,
            elevated: false,
            locks: [],
            message: `Failed to execute powercfg /requests: ${res.error.message}`
        };
    }

    if (res.status !== 0 || /requires administrator privileges|elevated command prompt/i.test(combined)) {
        return {
            audited: false,
            elevated: false,
            locks: [],
            message: 'Driver wake-lock audit skipped (powercfg /requests requires Administrator privileges).'
        };
    }

    const locks = [];
    let currentCategory = null;
    const lines = combined.split(/\r?\n/);

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (/^(DISPLAY|SYSTEM|AWAYMODE|EXECUTION|PERFBOOST|ACTIVELOCKSCREEN):$/i.test(line)) {
            currentCategory = line.replace(':', '').toUpperCase();
            continue;
        }

        if (currentCategory) {
            if (/^None\.?$/i.test(line)) {
                continue;
            }
            locks.push({
                category: currentCategory,
                entry: line
            });
        }
    }

    const message = locks.length === 0
        ? 'No active OS wake locks detected via powercfg /requests.'
        : `Detected ${locks.length} active OS wake lock(s) via powercfg /requests.`;

    return {
        audited: true,
        elevated: true,
        locks,
        message
    };
}

/**
 * Executes the native OS sleep or hibernate transition.
 * @param {Object} options
 * @returns {{ success: boolean, command?: string, message: string }}
 */
function executeSuspend(options = {}) {
    const mode = options.hibernate ? 'hibernate' : 'sleep';

    if (process.platform !== 'win32') {
        return {
            success: false,
            message: `Unsupported platform "${process.platform}". v0.1 currently supports Windows.`
        };
    }

    const psCommand = buildWindowsSuspendCommand(options);
    const psExe = resolveWindowsSystemExe(['WindowsPowerShell', 'v1.0', 'powershell.exe'], 'powershell.exe');

    if (options.dryRun) {
        return {
            success: true,
            command: psCommand,
            message: `[Dry Run] Would execute ${mode} via PowerShell CLR:\n  "${psExe}" -NoProfile -NonInteractive -Command "${psCommand}"`
        };
    }

    const result = spawnSync(psExe, [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        psCommand
    ], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    if (result.error) {
        return {
            success: false,
            command: psCommand,
            message: `Failed to trigger ${mode}: ${result.error.message}`
        };
    }

    if (result.status !== 0) {
        const errorDetails = (result.stderr || result.stdout || '').trim();
        return {
            success: false,
            command: psCommand,
            message: `PowerShell exited with code ${result.status}: ${errorDetails}`
        };
    }

    return {
        success: true,
        command: psCommand,
        message: `System successfully entered ${mode} and has now resumed.`
    };
}

module.exports = {
    resolveWindowsSystemExe,
    buildWindowsSuspendCommand,
    getAvailableSleepStates,
    auditPowerRequests,
    executeSuspend
};
