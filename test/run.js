const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { parseArgs } = require('../bin/agent-zzz');
const { formatLocalTimestamp, formatAuditReport, waitForIdle, runGraceCountdown, sleepSystem, telemetry, power, state } = require('../src/index');

test('parseArgs parses defaults and custom flags cleanly', () => {
    const defaults = parseArgs([]);
    assert.equal(defaults.delay, 30);
    assert.equal(defaults.force, true);
    assert.equal(defaults.waitIdle, true);
    assert.equal(defaults.hibernate, false);

    const custom = parseArgs(['--now', '--delay', '5', '--hibernate', '--no-force', '--exclude-session', 'abc-123']);
    assert.equal(custom.waitIdle, false);
    assert.equal(custom.delay, 5);
    assert.equal(custom.hibernate, true);
    assert.equal(custom.force, false);
    assert.equal(custom.excludeSession, 'abc-123');
});

test('buildWindowsSuspendCommand avoids rundll32 and builds safe CLR invocation', () => {
    const sleepCmd = power.buildWindowsSuspendCommand({});
    assert.match(sleepCmd, /System\.Windows\.Forms\.Application\]::SetSuspendState/);
    assert.match(sleepCmd, /PowerState\]::Suspend, \$true, \$false/);
    assert.doesNotMatch(sleepCmd, /rundll32/i);

    const hibCmd = power.buildWindowsSuspendCommand({ hibernate: true, force: false });
    assert.match(hibCmd, /PowerState\]::Hibernate, \$false, \$false/);
});

test('telemetry detects active sessions and applies self-exclusion properly', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-zzz-test-'));
    try {
        const selfId = 'self-session-1111';
        const otherId = 'other-session-2222';

        const selfLogDir = path.join(tmpRoot, 'brain', selfId, '.system_generated', 'logs');
        const otherLogDir = path.join(tmpRoot, 'brain', otherId, '.system_generated', 'logs');

        fs.mkdirSync(selfLogDir, { recursive: true });
        fs.mkdirSync(otherLogDir, { recursive: true });

        const activeTurn = [
            JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>Build open-source repo</USER_REQUEST>' }),
            JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 3, tool_calls: [{ name: 'run_command' }] })
        ].join('\n');

        fs.writeFileSync(path.join(selfLogDir, 'transcript.jsonl'), activeTurn);
        fs.writeFileSync(path.join(otherLogDir, 'transcript.jsonl'), activeTurn);

        // Without self-exclusion, both sessions are detected
        const allActive = telemetry.findActiveAntigravitySessions({
            appDataDir: tmpRoot,
            excludeSession: 'non-matching-id'
        });
        assert.equal(allActive.length, 2);

        // With self-exclusion, only the external session is detected
        const filtered = telemetry.findActiveAntigravitySessions({
            appDataDir: tmpRoot,
            excludeSession: selfId
        });
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0].id, otherId);
        assert.equal(filtered[0].tool, 'run_command');
        assert.equal(filtered[0].topic, 'Build open-source repo');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('state latch writes, reads, and marks resumed cleanly', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-zzz-state-'));
    const latchFile = path.join(tmpRoot, 'power-pause.json');

    try {
        const writeRes = state.writeStateLatch({ hibernate: false, invokingSessionId: 'sess-99' }, { stateFile: latchFile });
        assert.equal(writeRes.written, true);

        const readBefore = state.readStateLatch({ stateFile: latchFile });
        assert.equal(readBefore.action, 'suspend');
        assert.equal(readBefore.resumed, false);
        assert.equal(readBefore.invokingSessionId, 'sess-99');

        const resumeRes = state.markResumed({ stateFile: latchFile });
        assert.equal(resumeRes.updated, true);

        const readAfter = state.readStateLatch({ stateFile: latchFile });
        assert.equal(readAfter.resumed, true);
        assert.ok(readAfter.resumedAt);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('telemetry keeps unresolved background task active across text-only PLANNER_RESPONSE handoff', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-zzz-bgtask-'));
    try {
        const sessId = '71f654cf-test-bgtask';
        const logDir = path.join(tmpRoot, 'brain', sessId, '.system_generated', 'logs');
        fs.mkdirSync(logDir, { recursive: true });

        const transcriptPath = path.join(logDir, 'transcript.jsonl');
        const t0 = new Date('2026-11-09T05:37:49.000Z');
        const t1 = new Date('2026-11-09T05:38:06.000Z');

        const lines = [
            JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Implement DOMAIL-0048</USER_REQUEST>', created_at: t0.toISOString() }),
            JSON.stringify({
                step_index: 149,
                source: 'MODEL',
                type: 'GENERIC',
                status: 'RUNNING',
                created_at: t0.toISOString(),
                content: 'Tool is running as a background task with task id: 71f654cf-test-bgtask/task-149\nTask Description: mvn test -Dtest=WorkInventoryRegistryTest\nTask logs are available at: file:///C:/tmp/tasks/task-149.log'
            }),
            JSON.stringify({
                step_index: 150,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: t1.toISOString(),
                content: 'I have launched the test run and will wait for it to finish.'
            })
        ].join('\n');

        fs.writeFileSync(transcriptPath, lines);
        fs.utimesSync(transcriptPath, t1, t1);

        // 45 seconds after handoff message (past 15s recentTouch, build still running)
        const active = telemetry.findActiveAntigravitySessions({
            appDataDir: tmpRoot,
            nowMs: t1.getTime() + 45 * 1000
        });
        assert.equal(active.length, 1);
        assert.equal(active[0].id, sessId);
        assert.equal(active[0].state, 'running background task "task-149"');

        // Exceeds maxBackgroundTaskAgeSec (e.g. PC slept for 3 hours) -> expires cleanly
        const expired = telemetry.findActiveAntigravitySessions({
            appDataDir: tmpRoot,
            nowMs: t1.getTime() + 3 * 3600 * 1000
        });
        assert.equal(expired.length, 0);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('telemetry marks session idle once background task finishes and settle window elapses', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-zzz-bgtask-done-'));
    try {
        const sessId = '71f654cf-test-done';
        const logDir = path.join(tmpRoot, 'brain', sessId, '.system_generated', 'logs');
        const tasksDir = path.join(tmpRoot, 'brain', sessId, '.system_generated', 'tasks');
        fs.mkdirSync(logDir, { recursive: true });
        fs.mkdirSync(tasksDir, { recursive: true });

        const transcriptPath = path.join(logDir, 'transcript.jsonl');
        const taskLogPath = path.join(tasksDir, 'task-149.log');

        const tLaunch = new Date('2026-11-09T05:37:49.000Z');
        const tFinish = new Date('2026-11-09T05:38:48.000Z');
        const tReply = new Date('2026-11-09T05:38:55.000Z');

        fs.writeFileSync(taskLogPath, 'Build successful.\n');
        fs.utimesSync(taskLogPath, tFinish, tFinish);

        const lines = [
            JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Run verification build</USER_REQUEST>' }),
            JSON.stringify({
                step_index: 149,
                type: 'GENERIC',
                status: 'RUNNING',
                created_at: tLaunch.toISOString(),
                content: 'Tool is running as a background task with task id: 71f654cf-test-done/task-149\nTask Description: mvn test\nTask logs are available at: file:///C:/tmp/tasks/task-149.log'
            }),
            JSON.stringify({
                step_index: 151,
                source: 'SYSTEM',
                type: 'SYSTEM_MESSAGE',
                status: 'DONE',
                created_at: tFinish.toISOString(),
                content: '[Message] sender=71f654cf-test-done/task-149 content=Task id "71f654cf-test-done/task-149" finished with result: Exit 0'
            }),
            JSON.stringify({
                step_index: 152,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: tReply.toISOString(),
                content: 'All tests passed.'
            })
        ].join('\n');

        fs.writeFileSync(transcriptPath, lines);
        fs.utimesSync(transcriptPath, tReply, tReply);

        // Within 15s grace window right after final response
        const settling = telemetry.findActiveAntigravitySessions({
            appDataDir: tmpRoot,
            nowMs: tReply.getTime() + 5 * 1000
        });
        assert.equal(settling.length, 1);
        assert.equal(settling[0].state, 'active turn in progress');

        // Past 15s settle window and completed task log should not block
        const settled = telemetry.findActiveAntigravitySessions({
            appDataDir: tmpRoot,
            nowMs: tReply.getTime() + 25 * 1000
        });
        assert.equal(settled.length, 0);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('telemetry tracks CHECKPOINT compaction and SYSTEM_MESSAGE thinking turns', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-zzz-checkpoint-'));
    try {
        const sessCheckpoint = '71f654cf-checkpoint';
        const sessSysMsg = '446ae0b0-sysmsg';

        const cpDir = path.join(tmpRoot, 'brain', sessCheckpoint, '.system_generated', 'logs');
        const sysDir = path.join(tmpRoot, 'brain', sessSysMsg, '.system_generated', 'logs');
        fs.mkdirSync(cpDir, { recursive: true });
        fs.mkdirSync(sysDir, { recursive: true });

        const cpPath = path.join(cpDir, 'transcript.jsonl');
        const sysPath = path.join(sysDir, 'transcript.jsonl');
        const tBase = new Date('2026-11-09T05:40:01.000Z');

        fs.writeFileSync(cpPath, [
            JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Long session</USER_REQUEST>' }),
            JSON.stringify({ step_index: 157, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', content: '# Resuming from a compaction' })
        ].join('\n'));
        fs.utimesSync(cpPath, tBase, tBase);

        fs.writeFileSync(sysPath, [
            JSON.stringify({
                step_index: 0,
                source: 'SYSTEM',
                type: 'SYSTEM_MESSAGE',
                status: 'DONE',
                content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-09T05:05:40Z sender=parent priority=MESSAGE_PRIORITY_HIGH content=Analyze codebase and report\n</SYSTEM_MESSAGE>'
            })
        ].join('\n'));
        fs.utimesSync(sysPath, tBase, tBase);

        // 105 seconds later (model generating response after compaction / system message)
        const active = telemetry.findActiveAntigravitySessions({
            appDataDir: tmpRoot,
            nowMs: tBase.getTime() + 105 * 1000
        });
        assert.equal(active.length, 2);
        const byId = Object.fromEntries(active.map((s) => [s.id, s]));
        assert.equal(byId[sessCheckpoint].state, 'resuming after compaction');
        assert.equal(byId[sessSysMsg].state, 'model generating response');
        assert.equal(byId[sessSysMsg].topic, 'Analyze codebase and report');

        // 350 seconds later (past 300s maxThinkingAgeSec cap) -> settled/stale
        const timedOut = telemetry.findActiveAntigravitySessions({
            appDataDir: tmpRoot,
            nowMs: tBase.getTime() + 350 * 1000
        });
        assert.equal(timedOut.length, 0);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('telemetry detects active .system_generated/tasks/*.log output even when transcript is stale', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-zzz-tasklog-'));
    try {
        const sessId = '71f654cf-tasklog';
        const logDir = path.join(tmpRoot, 'brain', sessId, '.system_generated', 'logs');
        const tasksDir = path.join(tmpRoot, 'brain', sessId, '.system_generated', 'tasks');
        fs.mkdirSync(logDir, { recursive: true });
        fs.mkdirSync(tasksDir, { recursive: true });

        const transcriptPath = path.join(logDir, 'transcript.jsonl');
        const taskLogPath = path.join(tasksDir, 'task-169.log');

        const nowMs = Date.UTC(2026, 10, 9, 6, 0, 0);
        const staleTranscriptTime = new Date(nowMs - 1200 * 1000); // 20m ago (> 900s)
        const freshLogTime = new Date(nowMs - 3 * 1000); // 3s ago

        fs.writeFileSync(transcriptPath, [
            JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Run huge suite</USER_REQUEST>' }),
            JSON.stringify({ step_index: 170, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Waiting...' })
        ].join('\n'));
        fs.utimesSync(transcriptPath, staleTranscriptTime, staleTranscriptTime);

        fs.writeFileSync(taskLogPath, 'Running integration suite...\n');
        fs.utimesSync(taskLogPath, freshLogTime, freshLogTime);

        const active = telemetry.findActiveAntigravitySessions({
            appDataDir: tmpRoot,
            nowMs
        });
        assert.equal(active.length, 1);
        assert.equal(active[0].state, 'active task log "task-169.log"');
        assert.equal(active[0].ageSec, 3);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('telemetry ignores passive Timer/Cron schedule entries after turn settles', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-zzz-timer-'));
    try {
        const sessId = 'c5997a9a-timer';
        const logDir = path.join(tmpRoot, 'brain', sessId, '.system_generated', 'logs');
        const tasksDir = path.join(tmpRoot, 'brain', sessId, '.system_generated', 'tasks');
        fs.mkdirSync(logDir, { recursive: true });
        fs.mkdirSync(tasksDir, { recursive: true });

        const transcriptPath = path.join(logDir, 'transcript.jsonl');
        const timerLogPath = path.join(tasksDir, 'task-101.log');

        const tTimer = new Date('2026-11-09T05:05:53.000Z');
        fs.writeFileSync(timerLogPath, '');
        fs.utimesSync(timerLogPath, tTimer, tTimer);

        fs.writeFileSync(transcriptPath, [
            JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Daily cron</USER_REQUEST>' }),
            JSON.stringify({
                step_index: 101,
                source: 'MODEL',
                type: 'GENERIC',
                status: 'RUNNING',
                created_at: tTimer.toISOString(),
                content: 'Tool is running as a background task with task id: c5997a9a-timer/task-101\nTask Description: Timer: 30s, Prompt: Check status\nTask logs are available at: file:///C:/tmp/tasks/task-101.log'
            }),
            JSON.stringify({
                step_index: 102,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: tTimer.toISOString(),
                content: 'Timer scheduled.'
            })
        ].join('\n'));
        fs.utimesSync(transcriptPath, tTimer, tTimer);

        // 25s later (transcript settled, timer log touched recently 25s < 30s) -> should STILL be idle
        const active = telemetry.findActiveAntigravitySessions({
            appDataDir: tmpRoot,
            nowMs: tTimer.getTime() + 25 * 1000
        });
        assert.equal(active.length, 0);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('getTailEntries safely discards partial leading line when slicing large files', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-zzz-tail-'));
    try {
        const filePath = path.join(tmpRoot, 'transcript.jsonl');
        const records = [];
        for (let i = 0; i < 40; i++) {
            records.push(JSON.stringify({ step_index: i, type: 'GENERIC', status: 'DONE', padding: 'x'.repeat(120) }));
        }
        fs.writeFileSync(filePath, records.join('\n') + '\n');

        const { entries, truncated } = telemetry.getTailEntries(filePath, 600);
        assert.equal(truncated, true);
        assert.ok(entries.length >= 2 && entries.length < 40);
        assert.equal(entries[entries.length - 1].step_index, 39);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('telemetry prevents cross-transcript task ID leakage and respects manage_task terminal status', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-zzz-cross-'));
    try {
        const sessId = '59ce7061-caller';
        const otherId = '71f654cf-foreign';
        const logDir = path.join(tmpRoot, 'brain', sessId, '.system_generated', 'logs');
        fs.mkdirSync(logDir, { recursive: true });

        const transcriptPath = path.join(logDir, 'transcript.jsonl');
        const t0 = new Date('2026-11-09T05:40:00.000Z');
        const t1 = new Date('2026-11-09T05:45:00.000Z');

        const lines = [
            JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Inspect foreign transcript</USER_REQUEST>' }),
            // Reading another session's transcript (or quoting own session text) via read_file must NOT open a task
            JSON.stringify({
                step_index: 5,
                type: 'GENERIC',
                status: 'DONE',
                created_at: t0.toISOString(),
                content: `Showing lines 1-4 of 4\nTool is running as a background task with task id: ${otherId}/task-175\nTool is running as a background task with task id: ${sessId}/task-999\nTask Description: mvn test`
            }),
            // Session launches its own task and closes it via manage_task Status: DONE
            JSON.stringify({
                step_index: 6,
                type: 'GENERIC',
                status: 'RUNNING',
                created_at: t0.toISOString(),
                content: `Tool is running as a background task with task id: ${sessId}/task-6\nTask Description: node test.js`
            }),
            JSON.stringify({
                step_index: 7,
                type: 'GENERIC',
                status: 'DONE',
                created_at: t1.toISOString(),
                content: `Task: ${sessId}/task-6\nStatus: DONE`
            }),
            JSON.stringify({
                step_index: 8,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: t1.toISOString(),
                content: 'Finished auditing.'
            })
        ].join('\n');

        fs.writeFileSync(transcriptPath, lines);
        fs.utimesSync(transcriptPath, t1, t1);

        // Past 15s settle window -> must be cleanly idle (neither foreign task-175 nor closed task-6 lingers)
        const active = telemetry.findActiveAntigravitySessions({
            appDataDir: tmpRoot,
            nowMs: t1.getTime() + 25 * 1000
        });
        assert.equal(active.length, 0);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('formatLocalTimestamp and formatAuditReport include wall-clock timestamps and activity details', () => {
    const sample = new Date(2026, 10, 9, 6, 43, 5);
    assert.equal(formatLocalTimestamp(sample), '06:43:05');
    assert.equal(formatLocalTimestamp(sample, true), '2026-11-09 06:43:05');

    const report = formatAuditReport({
        checkedAt: sample.toISOString(),
        excludedSessionId: null,
        activeSessions: [
            {
                harness: 'antigravity',
                shortId: '71f654cf',
                topic: 'Implement WorkInventoryRegistry',
                step: 150,
                state: 'running background task "task-149"',
                ageSec: 12,
                lastActivityAt: new Date(sample.getTime() - 12 * 1000).toISOString()
            }
        ],
        sleepStates: { available: false, states: [] },
        powerAudit: { message: 'Skipped.', locks: [] }
    });

    assert.match(report, /^\[2026-11-09 06:43:05\] Agent-zzz telemetry audit:/m);
    assert.match(report, /step 150, running background task "task-149", 12s ago @ 06:42:53/);
});

test('waitForIdle logs wall-clock timestamps, step progress, and freshness across polling', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-zzz-wait-ts-'));
    try {
        const sessId = '71f654cf-wait-ts';
        const logDir = path.join(tmpRoot, 'brain', sessId, '.system_generated', 'logs');
        fs.mkdirSync(logDir, { recursive: true });

        const transcriptPath = path.join(logDir, 'transcript.jsonl');
        fs.writeFileSync(transcriptPath, [
            JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Wait test</USER_REQUEST>' }),
            JSON.stringify({ step_index: 42, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command' }] })
        ].join('\n'));

        const logs = [];
        let polls = 0;
        const origFind = telemetry.findActiveSessions;
        telemetry.findActiveSessions = () => {
            polls++;
            if (polls <= 2) {
                return [{
                    harness: 'antigravity',
                    id: sessId,
                    shortId: '71f654cf',
                    step: 41 + polls,
                    ageSec: 2,
                    lastActivityAt: new Date().toISOString(),
                    state: 'running tool "run_command"',
                    topic: 'Wait test'
                }];
            }
            return [];
        };

        try {
            const res = await waitForIdle(
                { appDataDir: tmpRoot, pollIntervalSeconds: 0.02, timeoutMinutes: 1 },
                (line) => logs.push(line)
            );
            assert.equal(res.ready, true);
        } finally {
            telemetry.findActiveSessions = origFind;
        }

        const joined = logs.join('\n');
        assert.match(joined, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] Detected 1 active agent session\(s\)/);
        assert.match(joined, /\[\d{2}:\d{2}:\d{2}\] \[\+\d+s\] Still waiting on: 71f654cf \(step 43, running tool "run_command", 2s ago\)/);
        assert.match(joined, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] All external agent sessions have settled into idle\./);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('parseArgs supports --check alias and rejects unknown flags or malformed values before sleeping', () => {
    const checkAlias = parseArgs(['--check']);
    assert.equal(checkAlias.checkOnly, true);
    assert.deepEqual(checkAlias.unknownFlags, []);
    assert.deepEqual(checkAlias.errors, []);

    const unknown = parseArgs(['--unknown-flag']);
    assert.deepEqual(unknown.unknownFlags, ['--unknown-flag']);
    assert.ok(unknown.errors.length >= 1);

    const badDelay = parseArgs(['--delay', 'not-a-number', '--exclude-session']);
    assert.equal(badDelay.errors.length, 2);

    // End-to-end CLI invocation with unknown flag must fail fast with exit code 1 (never count down to sleep)
    const cliPath = path.join(__dirname, '..', 'bin', 'agent-zzz.js');
    const proc = spawnSync(process.execPath, [cliPath, '--unknown-flag'], { encoding: 'utf8' });
    assert.equal(proc.status, 1);
    assert.match(proc.stderr, /Unknown option: --unknown-flag/);
});

test('telemetry clears force-stopped sessions via .system_generated/messages and detects revival', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-zzz-forcestop-'));
    try {
        const sessId = '36cc4812-force-stop';
        const logDir = path.join(tmpRoot, 'brain', sessId, '.system_generated', 'logs');
        const tasksDir = path.join(tmpRoot, 'brain', sessId, '.system_generated', 'tasks');
        const msgDir = path.join(tmpRoot, 'brain', sessId, '.system_generated', 'messages');
        const undeliveredDir = path.join(msgDir, 'undelivered');
        fs.mkdirSync(logDir, { recursive: true });
        fs.mkdirSync(tasksDir, { recursive: true });
        fs.mkdirSync(undeliveredDir, { recursive: true });

        const tTask = new Date('2026-11-09T09:00:23.000Z');
        const tStop = new Date('2026-11-09T09:00:28.278Z');

        const transcriptPath = path.join(logDir, 'transcript.jsonl');
        fs.writeFileSync(transcriptPath, [
            JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: tTask.toISOString(), content: '<USER_REQUEST>Use qmd query</USER_REQUEST>' }),
            JSON.stringify({
                step_index: 4,
                type: 'GENERIC',
                status: 'RUNNING',
                created_at: tTask.toISOString(),
                content: `Tool is running as a background task with task id: ${sessId}/task-4\nTask Description: qmd query\nTask logs are available at: file:///C:/tmp/tasks/task-4.log`
            }),
            JSON.stringify({
                step_index: 5,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: tTask.toISOString(),
                content: 'Running search...'
            })
        ].join('\n'));
        fs.utimesSync(transcriptPath, tTask, tTask);
        fs.writeFileSync(path.join(tasksDir, 'task-4.log'), 'Searching...');
        fs.utimesSync(path.join(tasksDir, 'task-4.log'), tStop, tStop);

        const stopNoticeId = 'notice-stop-1';
        const taskCancelId = 'task-cancel-4';
        fs.writeFileSync(path.join(msgDir, `${stopNoticeId}.json`), JSON.stringify({
            id: stopNoticeId,
            recipient: sessId,
            sender: 'system',
            timestamp: tStop.toISOString(),
            content: '[Notice] All your subagents and background tasks have been stopped due to user force cancellation.'
        }));
        fs.writeFileSync(path.join(msgDir, `${taskCancelId}.json`), JSON.stringify({
            id: taskCancelId,
            recipient: sessId,
            sender: `${sessId}/task-4`,
            timestamp: tStop.toISOString(),
            content: `Task id "${sessId}/task-4" was canceled with result:\nTool execution was canceled`
        }));
        fs.writeFileSync(path.join(undeliveredDir, stopNoticeId), '');
        fs.writeFileSync(path.join(undeliveredDir, taskCancelId), '');

        // Even 10 seconds later (and 179s later as observed in live failure), session must be reported idle
        const checkAt10s = telemetry.findActiveAntigravitySessions({ appDataDir: tmpRoot, nowMs: tStop.getTime() + 10 * 1000 });
        assert.equal(checkAt10s.length, 0);

        const checkAt179s = telemetry.findActiveAntigravitySessions({ appDataDir: tmpRoot, nowMs: tStop.getTime() + 179 * 1000 });
        assert.equal(checkAt179s.length, 0);

        // Revival: new USER_INPUT arrives after forceStopMs and notice is marked read
        const tRevive = new Date(tStop.getTime() + 120 * 1000);
        fs.writeFileSync(path.join(msgDir, 'read.json'), JSON.stringify({ [stopNoticeId]: true, [taskCancelId]: true }));
        fs.rmSync(path.join(undeliveredDir, stopNoticeId));
        fs.rmSync(path.join(undeliveredDir, taskCancelId));
        fs.appendFileSync(transcriptPath, '\n' + JSON.stringify({
            step_index: 6,
            type: 'USER_INPUT',
            created_at: tRevive.toISOString(),
            content: 'Continue now'
        }));
        fs.utimesSync(transcriptPath, tRevive, tRevive);

        const revived = telemetry.findActiveAntigravitySessions({ appDataDir: tmpRoot, nowMs: tRevive.getTime() + 15 * 1000 });
        assert.equal(revived.length, 1);
        assert.equal(revived[0].state, 'model generating response');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('telemetry handles single-task cancellation in messages and blocks spoofed stdout quotes', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-zzz-taskcancel-'));
    try {
        const sessId = '59ce7061-single-cancel';
        const logDir = path.join(tmpRoot, 'brain', sessId, '.system_generated', 'logs');
        const msgDir = path.join(tmpRoot, 'brain', sessId, '.system_generated', 'messages');
        fs.mkdirSync(logDir, { recursive: true });
        fs.mkdirSync(msgDir, { recursive: true });

        const t0 = new Date('2026-11-09T09:10:00.000Z');
        const t1 = new Date('2026-11-09T09:10:10.000Z');
        const transcriptPath = path.join(logDir, 'transcript.jsonl');

        fs.writeFileSync(transcriptPath, [
            JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: t0.toISOString(), content: '<USER_REQUEST>Run two tasks</USER_REQUEST>' }),
            JSON.stringify({
                step_index: 1,
                type: 'GENERIC',
                status: 'RUNNING',
                created_at: t0.toISOString(),
                content: `Tool is running as a background task with task id: ${sessId}/task-1\nTask Description: build project`
            }),
            JSON.stringify({
                step_index: 2,
                type: 'GENERIC',
                status: 'RUNNING',
                created_at: t0.toISOString(),
                content: `Tool is running as a background task with task id: ${sessId}/task-2\nTask Description: secondary probe`
            }),
            JSON.stringify({
                step_index: 3,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: t0.toISOString(),
                content: 'Monitoring both tasks.'
            })
        ].join('\n'));
        fs.utimesSync(transcriptPath, t0, t0);

        // Cancel only task-2, plus write a task-0 finish message whose stdout quotes force-stop & task-1 cancel
        fs.writeFileSync(path.join(msgDir, 'cancel-2.json'), JSON.stringify({
            id: 'cancel-2',
            recipient: sessId,
            sender: `${sessId}/task-2`,
            timestamp: t1.toISOString(),
            content: `Task id "${sessId}/task-2" was canceled with result:\nTool execution was canceled`
        }));
        fs.writeFileSync(path.join(msgDir, 'spoof-0.json'), JSON.stringify({
            id: 'spoof-0',
            recipient: sessId,
            sender: `${sessId}/task-0`,
            timestamp: t1.toISOString(),
            content: `Task id "${sessId}/task-0" finished with result:\n[Notice] All your subagents and background tasks have been stopped\nTask id "${sessId}/task-1" was canceled with result:`
        }));

        // task-1 must STILL keep the session active even though task-2 was canceled and task-0 stdout spoofed strings
        const active = telemetry.findActiveAntigravitySessions({ appDataDir: tmpRoot, nowMs: t1.getTime() + 45 * 1000 });
        assert.equal(active.length, 1);
        assert.equal(active[0].state, 'running background task "task-1"');

        // Also verify a standalone tailing GENERIC RUNNING task cleared via messages/ goes idle without 120s linger
        const soloId = '6246336f-tail-cancel';
        const soloLogDir = path.join(tmpRoot, 'brain', soloId, '.system_generated', 'logs');
        const soloMsgDir = path.join(tmpRoot, 'brain', soloId, '.system_generated', 'messages');
        fs.mkdirSync(soloLogDir, { recursive: true });
        fs.mkdirSync(soloMsgDir, { recursive: true });
        const soloTranscript = path.join(soloLogDir, 'transcript.jsonl');
        fs.writeFileSync(soloTranscript, [
            JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: t0.toISOString(), content: '<USER_REQUEST>Canceled solo task</USER_REQUEST>' }),
            JSON.stringify({
                step_index: 3,
                type: 'GENERIC',
                status: 'RUNNING',
                created_at: t0.toISOString(),
                content: `Tool is running as a background task with task id: ${soloId}/task-3\nTask Description: qmd query`
            })
        ].join('\n'));
        fs.utimesSync(soloTranscript, t0, t0);
        fs.writeFileSync(path.join(soloMsgDir, 'c3.json'), JSON.stringify({
            id: 'c3',
            recipient: soloId,
            sender: `${soloId}/task-3`,
            timestamp: t1.toISOString(),
            content: `Task id "${soloId}/task-3" was canceled with result:\nTool execution was canceled`
        }));

        const afterSoloCancel = telemetry.findActiveAntigravitySessions({ appDataDir: tmpRoot, nowMs: t1.getTime() + 10 * 1000 });
        assert.equal(afterSoloCancel.filter((s) => s.id === soloId).length, 0);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('telemetry bounds non-bypass run_command to 45s, approval waits to 60s, sync tools to 120s, and ignores ask_question', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-zzz-tools-'));
    try {
        const approvalId = '4afb5010-approval';
        const askId = '59ce7061-askq';
        const runId = '22223333-run';
        const editId = '11112222-edit';

        for (const id of [approvalId, askId, runId, editId]) {
            fs.mkdirSync(path.join(tmpRoot, 'brain', id, '.system_generated', 'logs'), { recursive: true });
        }

        const t0 = new Date('2026-11-09T09:03:51.000Z');

        const approvalPath = path.join(tmpRoot, 'brain', approvalId, '.system_generated', 'logs', 'transcript.jsonl');
        fs.writeFileSync(approvalPath, [
            JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Verify gate</USER_REQUEST>' }),
            JSON.stringify({
                step_index: 74,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: t0.toISOString(),
                tool_calls: [{ name: 'run_command', args: { BypassSandbox: 'true', WaitMsBeforeAsync: '10000' } }]
            })
        ].join('\n'));
        fs.utimesSync(approvalPath, t0, t0);

        const askPath = path.join(tmpRoot, 'brain', askId, '.system_generated', 'logs', 'transcript.jsonl');
        fs.writeFileSync(askPath, [
            JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Ask design question</USER_REQUEST>' }),
            JSON.stringify({
                step_index: 58,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: t0.toISOString(),
                tool_calls: [{ name: 'ask_question', args: { questions: [] } }]
            })
        ].join('\n'));
        fs.utimesSync(askPath, t0, t0);

        const runPath = path.join(tmpRoot, 'brain', runId, '.system_generated', 'logs', 'transcript.jsonl');
        fs.writeFileSync(runPath, [
            JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Quick shell command</USER_REQUEST>' }),
            JSON.stringify({
                step_index: 4,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: t0.toISOString(),
                tool_calls: [{ name: 'run_command', args: { WaitMsBeforeAsync: '5000' } }]
            })
        ].join('\n'));
        fs.utimesSync(runPath, t0, t0);

        const editPath = path.join(tmpRoot, 'brain', editId, '.system_generated', 'logs', 'transcript.jsonl');
        fs.writeFileSync(editPath, [
            JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Refactor module</USER_REQUEST>' }),
            JSON.stringify({
                step_index: 12,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: t0.toISOString(),
                tool_calls: [{ name: 'edit_file', args: { Path: 'src/app.js' } }]
            })
        ].join('\n'));
        fs.utimesSync(editPath, t0, t0);

        // At +10s: approval, non-bypass run_command, and edit_file are active; ask_question is ALREADY idle
        const at10s = telemetry.findActiveAntigravitySessions({ appDataDir: tmpRoot, nowMs: t0.getTime() + 10 * 1000 });
        const map10s = Object.fromEntries(at10s.map((s) => [s.id, s]));
        assert.equal(map10s[approvalId].state, 'awaiting approval for "run_command"');
        assert.equal(map10s[runId].state, 'running tool "run_command"');
        assert.equal(map10s[editId].state, 'running tool "edit_file"');
        assert.equal(map10s[askId], undefined);

        // At +55s (> 45s non-bypass run_command cap, <= 60s approval cap): approval & edit_file stay active, plain run_command expires
        const at55s = telemetry.findActiveAntigravitySessions({ appDataDir: tmpRoot, nowMs: t0.getTime() + 55 * 1000 });
        assert.deepEqual(at55s.map((s) => s.id).sort(), [editId, approvalId].sort());

        // At +70s (> 60s approval cap, <= 120s sync tool cap): approval expires, edit_file still active
        const at70s = telemetry.findActiveAntigravitySessions({ appDataDir: tmpRoot, nowMs: t0.getTime() + 70 * 1000 });
        assert.deepEqual(at70s.map((s) => s.id), [editId]);

        // At +150s (> 120s sync tool cap): edit_file expires cleanly instead of blocking 900s
        const at150s = telemetry.findActiveAntigravitySessions({ appDataDir: tmpRoot, nowMs: t0.getTime() + 150 * 1000 });
        assert.equal(at150s.length, 0);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('telemetry expires silent orphan background tasks at 300s while keeping streaming long builds alive', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-zzz-bgtask-silence-'));
    try {
        const silentId = 'silent-orphan-task';
        const streamingId = 'streaming-build-task';

        for (const id of [silentId, streamingId]) {
            fs.mkdirSync(path.join(tmpRoot, 'brain', id, '.system_generated', 'logs'), { recursive: true });
            fs.mkdirSync(path.join(tmpRoot, 'brain', id, '.system_generated', 'tasks'), { recursive: true });
        }

        const tLaunch = new Date('2026-11-09T09:00:00.000Z');
        const makeTranscript = (id) => [
            JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: tLaunch.toISOString(), content: '<USER_REQUEST>Build suite</USER_REQUEST>' }),
            JSON.stringify({
                step_index: 149,
                type: 'GENERIC',
                status: 'RUNNING',
                created_at: tLaunch.toISOString(),
                content: `Tool is running as a background task with task id: ${id}/task-149\nTask Description: mvn test\nTask logs are available at: file:///C:/tmp/tasks/task-149.log`
            }),
            JSON.stringify({ step_index: 150, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: tLaunch.toISOString(), content: 'Waiting...' })
        ].join('\n');

        const silentTranscript = path.join(tmpRoot, 'brain', silentId, '.system_generated', 'logs', 'transcript.jsonl');
        fs.writeFileSync(silentTranscript, makeTranscript(silentId));
        fs.utimesSync(silentTranscript, tLaunch, tLaunch);

        const streamTranscript = path.join(tmpRoot, 'brain', streamingId, '.system_generated', 'logs', 'transcript.jsonl');
        fs.writeFileSync(streamTranscript, makeTranscript(streamingId));
        fs.utimesSync(streamTranscript, tLaunch, tLaunch);

        const streamLog = path.join(tmpRoot, 'brain', streamingId, '.system_generated', 'tasks', 'task-149.log');
        const nowMs = tLaunch.getTime() + 600 * 1000; // 10 minutes after launch
        const recentWrite = new Date(nowMs - 45 * 1000); // log wrote 45s ago during quiet compile phase
        fs.writeFileSync(streamLog, '[INFO] Compiling module...\n');
        fs.utimesSync(streamLog, recentWrite, recentWrite);

        const active = telemetry.findActiveAntigravitySessions({ appDataDir: tmpRoot, nowMs });
        assert.deepEqual(active.map((s) => s.id), [streamingId]);
        assert.equal(active[0].state, 'running background task "task-149"');
        assert.equal(active[0].ageSec, 45);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('sleepSystem pauses grace countdown and resumes waiting when an external agent wakes up mid-countdown', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-zzz-countdown-resume-'));
    const latchFile = path.join(tmpRoot, 'power-pause.json');
    const logs = [];
    const origFind = telemetry.findActiveSessions;
    const origAuditPower = power.auditPowerRequests;
    const origSleepStates = power.getAvailableSleepStates;

    let callNum = 0;
    let suspendCalls = 0;

    telemetry.findActiveSessions = () => {
        callNum++;
        // Call 1 (initialAudit), Call 2 (waitForIdle initial -> idle), Call 3 (finalAudit before 1st countdown),
        // Call 4 (1st countdown tick -> idle), Call 5 (2nd countdown tick -> user approved step 76, 4afb5010 resumed!)
        if (callNum === 5 || callNum === 6 || callNum === 7) {
            return [{
                harness: 'antigravity',
                id: '4afb5010-resumed',
                shortId: '4afb5010',
                step: 78,
                ageSec: 1,
                lastActivityAt: new Date().toISOString(),
                state: 'running tool "read_file"',
                topic: 'VerificationAgent review'
            }];
        }
        return [];
    };
    power.auditPowerRequests = () => ({ locks: [], message: 'No active OS locks.' });
    power.getAvailableSleepStates = () => ({ available: true, states: ['Standby (S3)'] });

    try {
        const res = await sleepSystem({
            appDataDir: tmpRoot,
            stateFile: latchFile,
            platform: 'win32',
            delay: 0.08,
            countdownPollSeconds: 0.02,
            pollIntervalSeconds: 0.02,
            timeoutMinutes: 1,
            logFn: (line) => logs.push(line),
            executeSuspendFn: () => {
                suspendCalls++;
                return { success: true, message: 'Mock suspend triggered.' };
            }
        });

        assert.equal(res.success, true);
        assert.equal(suspendCalls, 1);

        const joined = logs.join('\n');
        assert.match(joined, /Sleep countdown paused: external agent session resumed:/);
        assert.match(joined, /4afb5010.*step 78, running tool "read_file"/);
        assert.match(joined, /Returning to active-session monitor/);
        // Must only trigger suspend after the second countdown finishes completely
        assert.ok(joined.indexOf('Returning to active-session monitor') < joined.indexOf('Triggering OS sleep now'));

        // Passing --now (waitIdle: false) must NOT monitor external activity during countdown
        callNum = 0;
        suspendCalls = 0;
        const nowRes = await sleepSystem({
            appDataDir: tmpRoot,
            stateFile: latchFile,
            platform: 'win32',
            waitIdle: false,
            delay: 0.05,
            logFn: () => {},
            executeSuspendFn: () => {
                suspendCalls++;
                return { success: true, message: 'Immediate suspend.' };
            }
        });
        assert.equal(nowRes.success, true);
        assert.equal(suspendCalls, 1);
    } finally {
        telemetry.findActiveSessions = origFind;
        power.auditPowerRequests = origAuditPower;
        power.getAvailableSleepStates = origSleepStates;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('telemetry fails closed on EPERM/EACCES sandbox isolation instead of reporting false idle', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-zzz-eperm-'));
    const blockedId = 'blocked-sibling-session';
    const selfId = 'self-calling-session';
    const origStatSync = fs.statSync;
    const origAuditPower = power.auditPowerRequests;
    const origSleepStates = power.getAvailableSleepStates;

    try {
        fs.mkdirSync(path.join(tmpRoot, 'brain', blockedId, '.system_generated', 'logs'), { recursive: true });
        fs.mkdirSync(path.join(tmpRoot, 'brain', selfId, '.system_generated', 'logs'), { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, 'brain', selfId, '.system_generated', 'logs', 'transcript.jsonl'), '{}\n');

        fs.statSync = (targetPath, ...rest) => {
            if (typeof targetPath === 'string' && targetPath.includes(blockedId) && targetPath.endsWith('transcript.jsonl')) {
                const err = new Error('EPERM: operation not permitted');
                err.code = 'EPERM';
                throw err;
            }
            return origStatSync.call(fs, targetPath, ...rest);
        };
        power.auditPowerRequests = () => ({ locks: [], message: 'No active OS locks.' });
        power.getAvailableSleepStates = () => ({ available: true, states: ['Standby (S3)'] });

        // Check-only must report blocked status and fail closed (success: false, readyToSleep: false)
        const checkRes = await sleepSystem({
            appDataDir: tmpRoot,
            excludeSession: selfId,
            checkOnly: true,
            platform: 'win32'
        });
        assert.equal(checkRes.success, false);
        assert.equal(checkRes.audit.readyToSleep, false);
        assert.equal(checkRes.audit.telemetryBlocked, true);
        assert.equal(checkRes.audit.unreadableSessions, 1);
        assert.match(checkRes.message, /TELEMETRY BLOCKED.*EPERM\/EACCES/i);

        // Normal sleep without --now must refuse to suspend blindly
        let suspendCalls = 0;
        const blockedRes = await sleepSystem({
            appDataDir: tmpRoot,
            excludeSession: selfId,
            platform: 'win32',
            delay: 0.02,
            executeSuspendFn: () => {
                suspendCalls++;
                return { success: true, message: 'Suspended.' };
            }
        });
        assert.equal(blockedRes.success, false);
        assert.equal(suspendCalls, 0);
        assert.match(blockedRes.message, /BypassSandbox: true/);

        // Explicit --now bypasses telemetry blocking intentionally
        const nowRes = await sleepSystem({
            appDataDir: tmpRoot,
            excludeSession: selfId,
            stateFile: path.join(tmpRoot, 'power-pause.json'),
            platform: 'win32',
            waitIdle: false,
            delay: 0.02,
            logFn: () => {},
            executeSuspendFn: () => {
                suspendCalls++;
                return { success: true, message: 'Suspended.' };
            }
        });
        assert.equal(nowRes.success, true);
        assert.equal(suspendCalls, 1);
    } finally {
        fs.statSync = origStatSync;
        power.auditPowerRequests = origAuditPower;
        power.getAvailableSleepStates = origSleepStates;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('power resolves System32 executables explicitly and state latch ignores ANTIGRAVITY_APP_DATA_DIR drift', () => {
    const origAppData = process.env.ANTIGRAVITY_APP_DATA_DIR;
    const origStateFile = process.env.AGENT_ZZZ_STATE_FILE;

    try {
        delete process.env.AGENT_ZZZ_STATE_FILE;
        process.env.ANTIGRAVITY_APP_DATA_DIR = path.join(os.tmpdir(), 'antigravity-sandbox-dir');
        const insideAgentPath = state.getStateLatchPath({});

        delete process.env.ANTIGRAVITY_APP_DATA_DIR;
        const outsideAgentPath = state.getStateLatchPath({});

        assert.equal(insideAgentPath, outsideAgentPath);
        assert.equal(
            outsideAgentPath,
            path.join(os.homedir(), '.gemini', 'agent-zzz', 'power-pause.json')
        );

        const overridePath = state.getStateLatchPath({ appDataDir: path.join(os.tmpdir(), 'custom-test-dir') });
        assert.equal(overridePath, path.join(os.tmpdir(), 'custom-test-dir', 'power-pause.json'));

        if (process.platform === 'win32') {
            const psExe = power.resolveWindowsSystemExe(['WindowsPowerShell', 'v1.0', 'powershell.exe'], 'powershell.exe');
            const pcfgExe = power.resolveWindowsSystemExe(['powercfg.exe'], 'powercfg');
            assert.match(psExe, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
            assert.match(pcfgExe, /\\System32\\powercfg\.exe$/i);

            const dryRun = power.executeSuspend({ dryRun: true });
            assert.equal(dryRun.success, true);
            assert.match(dryRun.message, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/i);
        }
    } finally {
        if (origAppData === undefined) delete process.env.ANTIGRAVITY_APP_DATA_DIR;
        else process.env.ANTIGRAVITY_APP_DATA_DIR = origAppData;
        if (origStateFile === undefined) delete process.env.AGENT_ZZZ_STATE_FILE;
        else process.env.AGENT_ZZZ_STATE_FILE = origStateFile;
    }
});
