```text
  ─────────────────────────────────────────────────────────────
        ▄▄██▀       ╭───────────────────╮               *
       ███▀         │  > agents: 0 idle │         .
      ████          │    [ - _ - ]      │                  *
       ███▄         ╰─────────┬─────────╯              ▀▀▀██
        ▀▀██▄             ╭───┴───╮            ▄▄▄▄▄    ▄█▀
                                                 ▄█▀   ▀▀▀▀▀
     ▄▀▀▀▄ ▄▀▀▀▀ █▀▀▀▀ █▄  █ ▀▀█▀▀     ▀▀▀██   ▄██▄▄
     █▀▀▀█ █  ▀█ █▀▀▀  █ ▀▄█   █   ▀▀▀  ▄█▀
     ▀   ▀  ▀▀▀▀ ▀▀▀▀▀ ▀   ▀   ▀       ▀▀▀▀▀

      agent-aware computer sleep  ·  wait · count · suspend
  ─────────────────────────────────────────────────────────────
```

<div align="center">

**Put your computer to sleep—only after every coding agent finishes.**

[![Platform: Windows 10/11](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D6?style=flat-square)](docs/cli-and-setup.md)
[![Node.js >=18](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square)](package.json)
[![Dependencies: Zero](https://img.shields.io/badge/Dependencies-Zero-success?style=flat-square)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

</div>

> **Current POC (v0.1)**: Verified telemetry on **Windows 10/11 + Google Antigravity**. **Claude Code**, **GitHub Copilot** (VS Code & CLI), and **Cursor** install `/zzz` via `agent-zzz setup`, but still need real-world harness testing and telemetry—please try them out and [report issues](https://github.com/pipik-roman/agent-zzz/issues).

```text
$ npx agent-zzz

[2026-11-09 23:40:12] Detected 1 active agent session(s) in progress:
  - [antigravity:71f654cf] "Run integration suite" (step 149, running background task "task-149", active 4s ago @ 23:40:08)
Waiting for active turns and tools to complete before sleeping... (Pass --now to bypass)

[23:40:17] [+5s] Still waiting on: 71f654cf (step 150, running background task "task-149", 2s ago)
[2026-11-09 23:40:42] All external agent sessions have settled into idle.

[2026-11-09 23:40:42] System will enter sleep in 30 second(s). Press Ctrl+C to abort.
  [23:40:52] ... 20s remaining before sleep
  [23:41:02] ... 10s remaining before sleep
[2026-11-09 23:41:12] Triggering OS sleep now...
```

---

## Why `agent-zzz` Exists

I run coding agents locally on my workstation and don't want the machine staying on through the night. Because I often trigger sleep via remote control after stepping away, I wrote a small script to make sure the machine actually sleeps—without getting dropped by sandboxing, low privileges, or Windows API quirks, and without cutting off active agent sessions that are still working (while ignoring sessions merely waiting on my input).

Unlike `asyncio.sleep` timers or LLM memory "dream cycles" that only pause software, `agent-zzz` puts the physical hardware to sleep after verifying every concurrent session has settled.

| Approach | Sees Sibling Agents | Avoids Self-Deadlock | Windows ABI Safe | Zero Daemon |
| :--- | :---: | :---: | :---: | :---: |
| **`rundll32.exe powrprof.dll`** | ❌ Blind | ❌ No | ❌ Broken | ✅ CLI |
| **`asyncio.sleep` / Dream MCPs** | ❌ Software wait only | N/A | ❌ Host stays awake | ❌ Server |
| **Generic Shell Scripts** | ❌ Blind | ❌ Deadlocks caller | ⚠️ Fragile | ✅ Script |
| **`agent-zzz`** | **✅ Audits live sessions** | **✅ Automatic** | **✅ Native CLR call** | **✅ CLI + Skill** |

> See [Engineering Issues Solved](docs/engineering-issues.md) for the real-world Windows ABI, sandbox `EPERM`, background-task handoff, cancellation, and mid-countdown wake-up issues uncovered during manual testing.

---

## 30-Second Quickstart

Install the `/zzz` skill interactively into detected AI IDEs (Antigravity, Claude Code, GitHub Copilot, Cursor, `.agents`):

```bash
npx agent-zzz setup
```

Inspect active sessions and OS sleep locks without changing power state:

```bash
npx agent-zzz --check
```

Wait for concurrent agents to finish, count down 30 seconds, and sleep:

```bash
npx agent-zzz
```

Install the CLI globally to unlock the short `zzz` alias (`zzz`, `zzz --check`, `zzz --now`):

```bash
npm install -g agent-zzz
```

---

## Common Commands

```bash
agent-zzz setup           # Detect AI IDEs and install /zzz interactively
agent-zzz --check         # Audit active agent sessions & OS wake locks
agent-zzz                 # Wait for idle, run live 30s countdown, then sleep
agent-zzz --now --delay 5 # Skip waiting and sleep after 5 seconds
agent-zzz --hibernate     # Hibernate (S4) instead of Standby (S3/S0ix)
agent-zzz --dry-run       # Preview audit & power command without sleeping
```

> Full CLI flags, `setup` options (`--client`, `--scope`, `--dry-run`, `--uninstall`), sandbox rules, and `power-pause.json` resume markers live in [CLI & Setup Guide](docs/cli-and-setup.md).

---

## First-Time Agentic Setup & Warm-Up

Prevent unattended sleep runs from stalling on IDE permission prompts or sandbox blocks:

1. **Install globally** so agents call `agent-zzz` directly without `npx` filters:

   ```bash
   npm install -g agent-zzz
   ```

2. **Install the skill outside any sandbox** (writes to `~/.gemini/config/skills/`, `~/.claude/skills/`, `~/.copilot/skills/`, etc.):

   ```bash
   agent-zzz setup
   ```

3. **Run an immediate warm-up while at your keyboard**:
   - Ask your agent: *"Warm up `/zzz`: run `agent-zzz --check` outside the sandbox, then start `agent-zzz` in the background and cancel it immediately during the 30s countdown."*
   - Choose **Always Allow** on both prompts so you save unsandboxed permissions for future runs.

> **Tip — Start `/zzz` in a Separate Chat:** Avoid queuing `/zzz` onto a busy turn where prompts wait behind long tasks. Open a lightweight second chat and run `/zzz` right away—it checks wake locks while you watch and puts your machine to sleep as soon as the primary session finishes.

---

## Built-In Safety

- **100% Offline & Local-Only**: Makes zero network calls and never uploads, stores, or processes conversation content—transcript checks run strictly in local memory to detect active tool and task states.
- **Zero Dependencies**: Uses only Node.js built-in modules. No third-party packages or install scripts.
- **Live Countdown Watch**: Polls sibling sessions every 2 seconds during the 30-second countdown and pauses automatically if work resumes.
- **Fail-Closed Sandboxing**: Aborts instead of sleeping blindly if sandbox permissions block sibling transcript reads (`EPERM`/`EACCES`).
- **Hardened Windows Binaries**: Resolves `powershell.exe` and `powercfg.exe` from `%SystemRoot%\System32` (`shell: false`). See [SECURITY.md](SECURITY.md).

---

## Roadmap

### High Priority — Primary Agents & OS Support
- [ ] Session telemetry for **Claude Code** and **GitHub Copilot** (VS Code & Copilot CLI)
- [ ] Cross-platform power dispatchers for **macOS** (`pmset sleepnow`) and **Linux** (`systemd-logind` D-Bus)

### Medium Priority — Laptop & Build Safety
- [ ] **Safe low-battery fallback**: when invoked on a laptop below 15% battery, automatically use Hibernate (S4) instead of Standby (S3) so RAM cannot drain overnight
- [ ] **Post-build thermal cooldown**: brief fan spin-down check after heavy builds before cutting power

### Lower Priority — Package Managers
- [ ] Native OS package installs via **Homebrew**, **Winget**, and **Scoop**

---

## License

MIT © [Roman Pipík](https://github.com/pipik-roman) and contributors. See [LICENSE](LICENSE).
