# Engineering Issues Solved During Manual Testing

Building a reliable sleep command for autonomous coding agents required solving a set of concrete OS, sandbox, and transcript-state issues uncovered during real multi-agent runs.

---

## 1. OS Power & Sandbox Issues

### 1.1 The Windows `rundll32` ABI Pointer Issue
Many scripts suspend Windows with `rundll32.exe powrprof.dll,SetSuspendState 0,1,0`. Because `rundll32` expects a `CALLBACK(HWND, HINSTANCE, LPSTR, int)` signature, Windows passes a non-zero window handle (`HWND`) as the `BOOLEAN Hibernate` argument—forcing full hibernation or silently dropping the call when hibernation is disabled.

- **Fix**: `agent-zzz` invokes `System.Windows.Forms.Application::SetSuspendState` via `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` (`shell: false`), giving deterministic Standby (`S3`/`S0ix`) or Hibernate (`S4`) behavior.

### 1.2 Silent False-Idle Inside Workspace Sandboxes (`EPERM`/`EACCES`)
Inside sandboxed agent harnesses, `fs.existsSync` on sibling session directories returns `false` on `EPERM`/`EACCES`. A naive scanner mistakes permission denial for "zero active sessions" and sleeps while sibling agents are still building.

- **Fix**: `agent-zzz` probes sibling transcripts with `fs.statSync` / `fs.accessSync`, tracks unreadable session counts (`telemetryBlocked`), and **fails closed**—aborting instead of sleeping blindly unless you run outside the sandbox (`BypassSandbox: true`) or explicitly pass `--now`.

### 1.3 Sandbox `ANTIGRAVITY_APP_DATA_DIR` Path Drift on State Latch
Sandboxed agent environments can override `ANTIGRAVITY_APP_DATA_DIR` to a session-scoped path that differs from the host user profile path, breaking post-wake detection of `power-pause.json`.

- **Fix**: `agent-zzz` anchors `~/.gemini/agent-zzz/power-pause.json` to `os.homedir()` (with explicit `AGENT_ZZZ_STATE_FILE` override), keeping pre-sleep and post-wake markers aligned across sandbox boundaries.

---

## 2. Multi-Agent Concurrency & Transcript Issues

### 2.1 Self-Deadlock on the Calling Conversation
When an agent invokes a sleep checker that scans active transcripts on disk, it detects its own active turn and waits forever for itself to finish.

- **Fix**: `agent-zzz` reads `ANTIGRAVITY_CONVERSATION_ID` (or `--exclude-session <id>`) and excludes the calling session before evaluating concurrency.

### 2.2 Background Tasks Across Text-Only Handoffs & Quiet Compile Phases
When an agent launches a background build (`mvn test`, `npm test`) and emits a text-only `PLANNER_RESPONSE` ("Waiting for tests to finish..."), the transcript's latest entry looks like a completed model reply even though the child process is still running. During long compile phases, `transcript.jsonl` also stops updating while `.system_generated/tasks/*.log` continues streaming output.

- **Fix**: `agent-zzz` tracks open background task IDs across text-only handoffs and checks `.system_generated/tasks/*.log` modification timestamps directly, keeping the session marked active while logs stream and bounding silent orphan tasks at 300 seconds.

### 2.3 Force-Stopped Sessions & Canceled Tasks in `.system_generated/messages/`
When a user force-stops a running session or cancels a background task, the harness writes cancellation notices under `.system_generated/messages/` instead of appending to `transcript.jsonl`. Without checking `messages/`, a canceled task kept the machine awake for minutes.

- **Fix**: `agent-zzz` inspects `.system_generated/messages/` for force-stop and single-task cancellation notices and clears canceled tasks immediately while still detecting subsequent session revival on new `USER_INPUT`.

### 2.4 Cross-Transcript Task ID Leakage & Passive `Timer:`/`Cron:` Schedules
Reading another session's transcript via `read_file` or quoting task logs in command output embeds foreign task IDs inside tool output. Similarly, passive `Timer:` or `Cron:` schedules create background entries that should not block workstation sleep after a turn settles.

- **Fix**: Task IDs are scoped strictly to the owning session ID, and passive `Timer:`/`Cron:`/`Schedule:` tasks are excluded once the turn completes.

### 2.5 Human-Input Idle (`ask_question`) vs. Bounded Active Tool Windows
A session waiting on `ask_question` is waiting for human input—it should not hold the workstation awake all night. Conversely, active shell commands, `BypassSandbox` approval gates, and file edits need realistic upper bounds so a crashed turn cannot block sleep indefinitely.

- **Fix**: `ask_question` transitions immediately to idle; non-bypass shell commands are bounded to `45s`, `BypassSandbox` approval waits to `60s`, synchronous tools to `120s`, and compaction/thinking turns to `300s`.

---

## 3. Countdown & CLI Safety Issues

### 3.1 External Agent Wake-Up Mid-Countdown
Another coding session can wake up or receive user approval after the pre-flight audit passes and the 30-second sleep countdown has already started.

- **Fix**: Unless `--now` is passed, `agent-zzz` polls sibling sessions every 2 seconds during the grace countdown and pauses automatically if another session becomes active, returning to the idle-wait loop.

### 3.2 Fail-Fast CLI Flag Validation
Passing an unknown flag or malformed timeout value must never fall through to default sleep execution.

- **Fix**: Both root `agent-zzz` and `agent-zzz setup` reject unknown flags, missing option values, and subcommand mismatches with exit code `1` before touching power state.
