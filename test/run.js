const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { parseArgs } = require('../bin/agent-zzz');
const { telemetry, power, state } = require('../src/index');

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
