# Security Policy

## Supported Versions

Only the latest release on the `main` branch receives security updates.

| Version | Supported |
| :--- | :--- |
| Latest (`main`) | :white_check_mark: |
| Older | :x: |

## Security Architecture & Threat Model

`agent-zzz` controls physical workstation power states and reads local agent session metadata. Its design keeps the attack surface minimal:

- **Zero Runtime Dependencies**: No third-party npm packages and no `preinstall`/`postinstall` lifecycle scripts.
- **Zero Outbound Network Calls**: Telemetry reads only local agent session transcripts (`transcript.jsonl`, task logs, and message receipts) on disk. File contents never leave your workstation.
- **Fail-Closed Concurrency Telemetry**: If sibling session transcripts return `EPERM` or `EACCES` (for example inside an isolated workspace sandbox), `agent-zzz` aborts instead of reporting an empty idle list unless `--now` is explicitly passed.
- **Explicit System Binary Paths**: Windows commands resolve executables explicitly from `%SystemRoot%\System32` (`powercfg.exe`, `WindowsPowerShell\v1.0\powershell.exe`) with `shell: false`, preventing current-working-directory executable hijacking inside untrusted repositories.
- **Prompt-Injection Defense**: Unattended `--now -d 0` flags should never be globally auto-approved in agent harnesses. The default 30-second live-monitored grace countdown allows the user to cancel with `Ctrl+C` if a prompt unexpectedly requests sleep.

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Please submit vulnerability reports privately using GitHub's **Private Vulnerability Reporting**:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Fill out the private report form.

This notifies maintainers privately on GitHub without exposing your report or private addresses.

### Response Timeline

- **Acknowledgment**: Within 7 days.
- **Remediation**: Confirmed issues will be patched on `main` and released via a signed/provenance-attested npm release.
