---
name: zzz
description: Safely puts the physical host PC or notebook to sleep (OS standby/hibernate) after checking that all concurrent AI coding agent sessions have settled into idle. Not a software sleep/delay timer or memory dream cycle.
---

# Safe Physical Host Sleep (`/zzz`)

Use this skill whenever the user asks to **put the PC to sleep**, **suspend the computer**, **hibernate the workstation**, or **sleep automatically after tasks finish**.

> [!IMPORTANT]
> This tool controls **physical operating system power states**. It is NOT an in-process delay timer (`asyncio.sleep`) and NOT a memory consolidation ("dream") routine.

---

## Operational Workflow

### 1. Pre-Flight Diagnostic Check (Non-Mutating)
Before suspending, inspect concurrent sessions and system power locks:

```bash
npx agent-zzz --check-only
```

- If active external agent sessions are detected, inform the user which sessions are currently running.
- If the user asked to sleep *immediately*, use `--now`.
- If the user asked to sleep *when all tasks finish*, run the default wait-and-sleep sequence.

### 2. Trigger Safe Coordinated Sleep

```bash
npx agent-zzz
```

What this automatically handles:
1. **Self-Exclusion**: Automatically excludes your current conversation ID (`ANTIGRAVITY_CONVERSATION_ID`) so the agent never deadlocks waiting for itself.
2. **Concurrency Polling**: Waits (up to 30m by default) until all other active agent sessions settle into idle.
3. **Hardened OS Suspend**: Uses WinForms CLR `SetSuspendState` on Windows, avoiding the `rundll32.exe powrprof.dll` Win32 ABI pointer trap that triggers unintended hibernation or silent drops.
4. **30s Grace Countdown**: Streams an abortable 30-second countdown so a human at the keyboard can cancel (`Ctrl+C`), while allowing unattended tasks to finish cleanly.
5. **Durable State Latch**: Writes `~/.gemini/power-pause.json` prior to suspending so harnesses know upon wake-up that the pause was intentional.

---

## Useful Flags

| Flag | Effect |
| :--- | :--- |
| `--check-only` / `--check` / `-c` | Display active agent sessions and OS wake locks without sleeping |
| `--now` / `--skip-wait` | Bypass waiting for other active coding sessions |
| `--delay <sec>` / `-d` | Override the 30-second grace countdown (e.g., `-d 5`) |
| `--hibernate` | Hibernate (S4 Suspend-to-Disk) instead of Standby (S3/S0ix) |
| `--no-force` | Respect OS driver/application wake locks instead of forcing sleep |
| `--dry-run` | Simulate the audit and print the exact power command without executing |

---

## Prohibited Actions
- **NEVER** execute `rundll32.exe powrprof.dll,SetSuspendState 0,1,0`. It suffers from an ABI signature mismatch and silently fails or hibernates unexpectedly.
- **NEVER** put the machine to sleep blindly without running `agent-zzz` concurrency checks unless the user explicitly passes `--now`.
