# `agent-zzz` CLI Reference & Skill Setup Guide

This guide covers full CLI options, AI IDE skill paths, sandbox behavior, and post-wake state markers for `agent-zzz`.

---

## 1. Full CLI Reference

### Power Controller (`agent-zzz`)

```text
Usage:
  agent-zzz [options]
  agent-zzz setup [options]
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
```

### Interactive Skill Installer (`agent-zzz setup`)

```text
Usage:
  agent-zzz setup [options]
  agent-zzz install-skill [options]

Options:
  --client <name|all>       Target client directly (antigravity, claude-code, copilot, agents, cursor, all)
  --scope <global|workspace>
                            Install in user home directory (default) or current workspace (--scale alias)
  --dry-run                 Preview detected clients and paths without writing files
  --force, -f               Overwrite existing SKILL.md if local edits differ
  --uninstall, --remove     Remove installed zzz/SKILL.md from selected client(s)
  --json                    Output setup results as JSON (requires --client)
  --help, -h                Show setup help
```

---

## 2. Installing the `/zzz` Agent Skill

Run `npx agent-zzz setup` to detect installed AI harnesses on your machine and copy [`skills/zzz/SKILL.md`](../skills/zzz/SKILL.md) interactively with explicit confirmation:

```bash
# Detect installed AI IDEs and choose interactively (global scope by default)
npx agent-zzz setup

# Preview detected targets without writing any files
npx agent-zzz setup --dry-run --client all

# Scripted install for a single client or workspace
npx agent-zzz setup --client claude-code
npx agent-zzz setup --client copilot --scope workspace
```

| AI Harness / ID | Global Target Path | Workspace Target (`--scope workspace`) | Telemetry Support |
| :--- | :--- | :--- | :--- |
| **Google Antigravity** (`antigravity`) | `~/.gemini/config/skills/zzz/SKILL.md` | `./.agents/skills/zzz/SKILL.md` | Full telemetry + `/zzz` in v0.1 |
| **Claude Code** (`claude-code`) | `~/.claude/skills/zzz/SKILL.md` | `./.claude/skills/zzz/SKILL.md` | `/zzz` trigger in v0.1; telemetry in P0 |
| **GitHub Copilot** (`copilot`) | `~/.copilot/skills/zzz/SKILL.md` | `./.github/skills/zzz/SKILL.md` | `/zzz` trigger in v0.1; telemetry in P0 |
| **Universal** (`agents`) | `~/.agents/skills/zzz/SKILL.md` | `./.agents/skills/zzz/SKILL.md` | Portable workspace/home skill standard |
| **Cursor** (`cursor`) | `~/.cursor/skills/zzz/SKILL.md` | `./.cursor/skills/zzz/SKILL.md` | `/zzz` trigger in v0.1 |

> **Tip**: Global installation (`--scope global`, default) avoids polluting Git repositories with IDE config folders. Keep human approval enabled in your agent harness for `agent-zzz --now` or `--delay 0` so untrusted repository files cannot force instant sleep via prompt injection.

---

## 3. Sandbox & Privilege Behavior

- **Sibling Transcript Permissions (`EPERM`/`EACCES`)**: Inside sandboxed agent harnesses (such as Antigravity's workspace sandbox), reading sibling session transcripts under `~/.gemini/antigravity/brain/` returns `EPERM`. `agent-zzz` fails closed and refuses to sleep unless you run outside the sandbox (`BypassSandbox: true`) or explicitly pass `--now`.
- **OS Power Lock Auditing (`powercfg /requests`)**: Driver wake-lock inspection requires an elevated Administrator shell on Windows. In standard user terminals, `agent-zzz` logs that the driver check was skipped and uses `powercfg /availablesleepstates` plus transcript telemetry cleanly.

---

## 4. Durable Pre-Sleep State Latch (`power-pause.json`)

Before cutting power, `agent-zzz` writes `~/.gemini/agent-zzz/power-pause.json` (override with `AGENT_ZZZ_STATE_FILE`). Once the workstation wakes up, it updates `resumed: true`:

```json
{
  "source": "agent-zzz",
  "action": "suspend",
  "invokingSessionId": "59ce7061-8fd5-46c6-a182-384580e065e1",
  "timestamp": "2026-11-09T23:41:12.000Z",
  "resumed": true,
  "resumedAt": "2026-11-10T06:58:03.000Z"
}
```

Inspect the latest latch from any terminal with:

```bash
agent-zzz --status
```
