#!/usr/bin/env node

const pkg = require('../package.json');
const { formatLocalTimestamp, sleepSystem, state } = require('../src/index');

/**
 * Parses CLI flags into an options object.
 * @param {string[]} argv
 * @returns {Object}
 */
function parseArgs(argv = []) {
    const options = {
        delay: 30,
        force: true,
        hibernate: false,
        disableWake: false,
        dryRun: false,
        waitIdle: true,
        timeoutMinutes: 30,
        pollIntervalSeconds: 5,
        checkOnly: false,
        status: false,
        json: false,
        excludeSession: null,
        help: false,
        version: false,
        unknownFlags: [],
        errors: []
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg === '--version' || arg === '-v') {
            options.version = true;
        } else if (arg === '--dry-run') {
            options.dryRun = true;
        } else if (arg === '--now' || arg === '--skip-wait') {
            options.waitIdle = false;
        } else if (arg === '--check-only' || arg === '--check' || arg === '-c') {
            options.checkOnly = true;
        } else if (arg === '--status') {
            options.status = true;
        } else if (arg === '--json') {
            options.json = true;
        } else if (arg === '--hibernate') {
            options.hibernate = true;
        } else if (arg === '--no-force') {
            options.force = false;
        } else if (arg === '--exclude-session') {
            const next = argv[i + 1];
            if (next && !next.startsWith('-')) {
                options.excludeSession = next;
                i++;
            } else {
                options.errors.push('Missing value for --exclude-session');
            }
        } else if (arg === '--delay' || arg === '-d') {
            const next = argv[i + 1];
            const parsed = next !== undefined ? parseInt(next, 10) : NaN;
            if (next && !next.startsWith('-') && !isNaN(parsed) && parsed >= 0) {
                options.delay = parsed;
                i++;
            } else {
                options.errors.push(`Invalid value for ${arg}: expected non-negative integer seconds`);
                if (next && !next.startsWith('-')) i++;
            }
        } else if (arg === '--timeout' || arg === '-t') {
            const next = argv[i + 1];
            const parsed = next !== undefined ? parseInt(next, 10) : NaN;
            if (next && !next.startsWith('-') && !isNaN(parsed) && parsed >= 0) {
                options.timeoutMinutes = parsed;
                i++;
            } else {
                options.errors.push(`Invalid value for ${arg}: expected non-negative integer minutes`);
                if (next && !next.startsWith('-')) i++;
            }
        } else if (arg === '--poll' || arg === '-p') {
            const next = argv[i + 1];
            const parsed = next !== undefined ? parseInt(next, 10) : NaN;
            if (next && !next.startsWith('-') && !isNaN(parsed) && parsed > 0) {
                options.pollIntervalSeconds = parsed;
                i++;
            } else {
                options.errors.push(`Invalid value for ${arg}: expected positive integer seconds`);
                if (next && !next.startsWith('-')) i++;
            }
        } else {
            options.unknownFlags.push(arg);
            options.errors.push(`Unknown option: ${arg}`);
        }
    }

    return options;
}

function showHelp() {
    console.log(`
agent-zzz v${pkg.version} — Safe, agent-aware physical PC sleep and power controller

Usage:
  agent-zzz [options]
  npx agent-zzz [options]

Options:
  --check-only, --check, -c Inspect active coding agent sessions & OS power locks without sleeping
  --json                    Output audit telemetry as structured JSON
  --now, --skip-wait        Sleep immediately without waiting for concurrent agent sessions
  --delay, -d <seconds>     Abortable grace countdown before sleeping (default: 30)
  --timeout, -t <minutes>   Maximum minutes to wait for active agent sessions (default: 30)
  --poll, -p <seconds>      Polling interval while waiting for idle state (default: 5)
  --hibernate               Hibernate (S4) instead of Standby/Sleep (S3/S0ix)
  --no-force                Allow OS applications/drivers to veto sleep via power locks
  --exclude-session <id>    Explicitly exclude a conversation/session ID from concurrency audit
  --status                  Display the last pre-sleep state latch marker (power-pause.json)
  --dry-run                 Simulate audit and display the exact OS suspend command without sleeping
  --version, -v             Show version number
  --help, -h                Show this help message

Examples:
  agent-zzz               # Audit active agents, wait until idle, 30s countdown, then sleep
  agent-zzz --check-only  # Check if any agent sessions or wake locks are active
  agent-zzz --now -d 5    # Skip agent wait and sleep after a 5-second countdown
  agent-zzz --dry-run     # Verify telemetry and power command without suspending
`.trim());
}

async function main() {
    const options = parseArgs(process.argv.slice(2));

    if (options.errors.length > 0) {
        for (const errMsg of options.errors) {
            console.error(`Error: ${errMsg}`);
        }
        console.error('Run "agent-zzz --help" to see valid options.');
        process.exit(1);
    }

    if (options.help) {
        showHelp();
        process.exit(0);
    }

    if (options.version) {
        console.log(pkg.version);
        process.exit(0);
    }

    if (options.status) {
        const latch = state.readStateLatch(options);
        if (options.json) {
            console.log(JSON.stringify(latch || { found: false }, null, 2));
        } else if (!latch) {
            console.log('No previous sleep latch recorded.');
        } else {
            console.log(`Last sleep latch (${latch.action}):`);
            console.log(`  Timestamp: ${latch.timestamp}`);
            console.log(`  Resumed:   ${latch.resumed ? `Yes (${latch.resumedAt})` : 'No (Pending or interrupted)'}`);
            if (latch.invokingSessionId) {
                console.log(`  Session:   ${latch.invokingSessionId}`);
            }
        }
        process.exit(0);
    }

    process.on('SIGINT', () => {
        console.log(`\n[${formatLocalTimestamp(new Date(), true)}] Sleep aborted by user.`);
        process.exit(130);
    });

    const result = await sleepSystem(options);

    if (options.json && options.checkOnly) {
        console.log(JSON.stringify(result.audit, null, 2));
        process.exit(result.success ? 0 : 1);
    }

    if (result.message) {
        if (result.success) {
            console.log(result.message);
        } else {
            console.error(`Error: ${result.message}`);
        }
    }

    process.exit(result.success ? 0 : 1);
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`Fatal error: ${err.message}`);
        process.exit(1);
    });
}

module.exports = { parseArgs };
