# 💤 `agent-zzz`

**Agent-aware physical PC sleep and hardware power management for autonomous coding agents.**

> *Your AI agents run long tasks while you step away. Leaving a 200W workstation idling for hours afterward wastes power and hardware. Blind sleep commands kill active agents or crash with Windows ABI bugs. `agent-zzz` puts your machine to sleep **only after all active coding agents finish**.*

---

## ⚡ Quick Start

Run a non-mutating check of active agent sessions and OS sleep states:
```bash
npx agent-zzz --check-only
```

Safely wait for concurrent agents to finish, count down 30 seconds, and suspend the PC:
```bash
npx agent-zzz
```

Install globally or link the `/zzz` skill:
```bash
npm install -g agent-zzz
```

---

## 🤔 Why `agent-zzz` Exists

Most developer tools with "sleep" in their name are either **memory consolidation loops** ("dream cycles") or **in-process delay timers** (`asyncio.sleep`) that leave your workstation running at full wattage. Generic desktop control scripts run blind shell commands that silently fail or wreck concurrent coding turns.

| Method / Tool | Multi-Agent Awareness | Self-Deadlock Exclusion | Windows ABI Safety | Zero Background Daemon |
| :--- | :---: | :---: | :---: | :---: |
| **`rundll32.exe powrprof.dll`** | ❌ Blind | ❌ None | ❌ Broken (Triggers S4/drops) | ✅ CLI |
| **Generic MCP Bridges** | ❌ Blind | ❌ None | ❌ Shell wrappers | ❌ 24/7 Server |
| **`asyncio.sleep` MCPs** | ❌ Software wait only | N/A | ❌ Does not sleep host | ❌ 24/7 Server |
| **`agent-zzz`** | **✅ Audits active sessions** | **✅ Automatic** | **✅ Native CLR invocation** | **✅ Lean CLI + Skill** |

### Three Problems Solved Out of the Box
1. **The Self-Deadlock Hazard**: When an agent asks "are any agents running?", naive scripts scan disk transcripts, discover the invoking conversation itself is active, and wait forever for themselves to finish. `agent-zzz` inspects runtime IDs (`ANTIGRAVITY_CONVERSATION_ID`, `--exclude-session`) for deterministic self-exclusion.
2. **The Windows `rundll32` ABI Trap**: Calling `rundll32.exe powrprof.dll,SetSuspendState 0,1,0` passes an `HWND` pointer instead of a boolean to `SetSuspendState`, forcing unwanted Hibernation or failing silently when hibernation is disabled. `agent-zzz` uses hardened WinForms CLR calls (`[System.Windows.Forms.Application]::SetSuspendState`).
3. **Aborted Streams & Corrupted Worktrees**: Instead of instantly severing TCP sockets when an agent wraps up, `agent-zzz` observes a 30-second abortable grace countdown and writes a durable state latch (`~/.gemini/power-pause.json`) so agents recognize an intentional sleep upon wake-up.

---

## 🛠️ CLI Reference

```text
Usage:
  agent-zzz [options]

Options:
  --check-only, --check, -c Inspect active coding agent sessions & OS power locks without sleeping
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
```

---

## 🤖 Installing the `/zzz` Agent Skill

`agent-zzz` ships a standardized `SKILL.md` manifest (`skills/zzz/SKILL.md`). Copy or symlink it into your agent harness skill directory to enable natural-language triggers (*"put my PC to sleep when done"*) and the `/zzz` slash command:

- **Google Antigravity (Global)**: `~/.gemini/config/skills/zzz/SKILL.md`
- **Workspace-scoped (Universal)**: `.agents/skills/zzz/SKILL.md`
- **Claude Code / Cursor**: `.claude/skills/zzz/SKILL.md` or `.cursor/skills/zzz/SKILL.md`

---

## 🗺️ Roadmap

- **v0.1 (Current POC)**:
  - Zero-dependency Node.js CLI
  - Google Antigravity transcript telemetry & deterministic self-exclusion
  - Hardened Windows PowerShell CLR suspend + `powercfg` audits
  - Durable `power-pause.json` latch & abortable 30s countdown
  - `/zzz` `SKILL.md` bundle
- **v0.2+ (Upcoming)**:
  - Multi-agent adapters: **Claude Code** (`~/.claude/projects/`), **Cursor** (`~/.cursor/`), and **Charm Crush** (`~/.config/crush/`)
  - Cross-platform OS dispatchers: **macOS** (`pmset sleepnow`, IOKit assertions) & **Linux** (`systemd-logind` D-Bus)
  - Laptop hardware guardrails: battery discharge protection (< 15% auto-hibernates) & thermal fan cooldown
  - Alternative zero-runtime compiled backend (Go/Rust)

---

## 📄 License

MIT © [Roman Pipík](https://github.com/pipik-roman) and contributors.
