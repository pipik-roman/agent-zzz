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
