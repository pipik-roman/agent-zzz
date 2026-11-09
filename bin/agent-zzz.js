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
        version: false
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
        } else if (arg === '--check-only' || arg === '-c') {
            options.checkOnly = true;
        } else if (arg === '--status') {
            options.status = true;
        } else if (arg === '--json') {
            options.json = true;
        } else if (arg === '--hibernate') {
            options.hibernate = true;
        } else if (arg === '--no-force') {
            options.force = false;
        } else if (arg === '--exclude-session' && argv[i + 1] && !argv[i + 1].startsWith('-')) {
            options.excludeSession = argv[i + 1];
            i++;
        } else if ((arg === '--delay' || arg === '-d') && argv[i + 1] && !argv[i + 1].startsWith('-')) {
            const parsed = parseInt(argv[i + 1], 10);
            if (!isNaN(parsed) && parsed >= 0) {
                options.delay = parsed;
                i++;
            }
        } else if ((arg === '--timeout' || arg === '-t') && argv[i + 1] && !argv[i + 1].startsWith('-')) {
            const parsed = parseInt(argv[i + 1], 10);
            if (!isNaN(parsed) && parsed >= 0) {
                options.timeoutMinutes = parsed;
                i++;
            }
        } else if ((arg === '--poll' || arg === '-p') && argv[i + 1] && !argv[i + 1].startsWith('-')) {
            const parsed = parseInt(argv[i + 1], 10);
            if (!isNaN(parsed) && parsed > 0) {
                options.pollIntervalSeconds = parsed;
                i++;
            }
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
  --check-only, -c        Inspect active coding agent sessions & OS power locks without sleeping
  --json                  Output audit telemetry as structured JSON
  --now, --skip-wait      Sleep immediately without waiting for concurrent agent sessions
  --delay, -d <seconds>   Abortable grace countdown before sleeping (default: 30)
  --timeout, -t <minutes> Maximum minutes to wait for active agent sessions (default: 30)
  --poll, -p <seconds>    Polling interval while waiting for idle state (default: 5)
  --hibernate             Hibernate (S4) instead of Standby/Sleep (S3/S0ix)
  --no-force              Allow OS applications/drivers to veto sleep via power locks
  --exclude-session <id>  Explicitly exclude a conversation/session ID from concurrency audit
  --status                Display the last pre-sleep state latch marker (power-pause.json)
  --dry-run               Simulate audit and display the exact OS suspend command without sleeping
  --version, -v           Show version number
  --help, -h              Show this help message

Examples:
  agent-zzz               # Audit active agents, wait until idle, 30s countdown, then sleep
  agent-zzz --check-only  # Check if any agent sessions or wake locks are active
  agent-zzz --now -d 5    # Skip agent wait and sleep after a 5-second countdown
  agent-zzz --dry-run     # Verify telemetry and power command without suspending
`.trim());
}

async function main() {
    const options = parseArgs(process.argv.slice(2));

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
