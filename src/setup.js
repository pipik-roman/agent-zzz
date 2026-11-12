const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const DEFAULT_SKILL_SOURCE = path.resolve(__dirname, '..', 'skills', 'zzz', 'SKILL.md');

/**
 * Resolves the platform-specific VS Code Copilot Chat global storage directory if present.
 * @param {string} homeDir
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function resolveVSCodeCopilotStorageDir(homeDir, platform = process.platform, env = process.env) {
    if (platform === 'win32') {
        const appData = env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
        return path.join(appData, 'Code', 'User', 'globalStorage', 'github.copilot-chat');
    }
    if (platform === 'darwin') {
        return path.join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'github.copilot-chat');
    }
    return path.join(homeDir, '.config', 'Code', 'User', 'globalStorage', 'github.copilot-chat');
}

/**
 * Supported AI coding harnesses and skill installation targets.
 */
const CLIENT_TARGETS = [
    {
        id: 'antigravity',
        name: 'Google Antigravity',
        aliases: ['agy', 'gemini-antigravity'],
        capability: 'Full telemetry + /zzz',
        detectGlobalDirs: (homeDir) => [
            path.join(homeDir, '.gemini', 'config'),
            path.join(homeDir, '.gemini', 'antigravity')
        ],
        globalSkillPath: (homeDir) => path.join(homeDir, '.gemini', 'config', 'skills', 'zzz', 'SKILL.md'),
        detectWorkspaceDirs: (cwd) => [path.join(cwd, '.agents')],
        workspaceSkillPath: (cwd) => path.join(cwd, '.agents', 'skills', 'zzz', 'SKILL.md')
    },
    {
        id: 'claude-code',
        name: 'Claude Code',
        aliases: ['claude'],
        capability: 'Skill trigger (/zzz) in v0.1; telemetry in P0',
        detectGlobalDirs: (homeDir) => [
            path.join(homeDir, '.claude'),
            path.join(homeDir, '.claude.json')
        ],
        globalSkillPath: (homeDir) => path.join(homeDir, '.claude', 'skills', 'zzz', 'SKILL.md'),
        detectWorkspaceDirs: (cwd) => [path.join(cwd, '.claude')],
        workspaceSkillPath: (cwd) => path.join(cwd, '.claude', 'skills', 'zzz', 'SKILL.md')
    },
    {
        id: 'copilot',
        name: 'GitHub Copilot (VS Code & CLI)',
        aliases: ['copilot-cli', 'github-copilot', 'vscode'],
        capability: 'Skill trigger (/zzz) in v0.1; telemetry in P0',
        detectGlobalDirs: (homeDir, platform, env) => [
            path.join(homeDir, '.copilot'),
            resolveVSCodeCopilotStorageDir(homeDir, platform, env)
        ],
        globalSkillPath: (homeDir) => path.join(homeDir, '.copilot', 'skills', 'zzz', 'SKILL.md'),
        detectWorkspaceDirs: (cwd) => [
            path.join(cwd, '.github'),
            path.join(cwd, '.vscode')
        ],
        workspaceSkillPath: (cwd) => path.join(cwd, '.github', 'skills', 'zzz', 'SKILL.md')
    },
    {
        id: 'agents',
        name: 'Universal (.agents)',
        aliases: ['universal'],
        capability: 'Portable SKILL.md standard',
        detectGlobalDirs: (homeDir) => [path.join(homeDir, '.agents')],
        globalSkillPath: (homeDir) => path.join(homeDir, '.agents', 'skills', 'zzz', 'SKILL.md'),
        detectWorkspaceDirs: (cwd) => [path.join(cwd, '.agents')],
        workspaceSkillPath: (cwd) => path.join(cwd, '.agents', 'skills', 'zzz', 'SKILL.md')
    },
    {
        id: 'cursor',
        name: 'Cursor',
        aliases: [],
        capability: 'Skill trigger (/zzz) in v0.1',
        detectGlobalDirs: (homeDir) => [path.join(homeDir, '.cursor')],
        globalSkillPath: (homeDir) => path.join(homeDir, '.cursor', 'skills', 'zzz', 'SKILL.md'),
        detectWorkspaceDirs: (cwd) => [path.join(cwd, '.cursor')],
        workspaceSkillPath: (cwd) => path.join(cwd, '.cursor', 'skills', 'zzz', 'SKILL.md')
    }
];

/**
 * Checks safely whether a file or directory path exists on disk.
 * @param {string} targetPath
 * @returns {boolean}
 */
function pathExists(targetPath) {
    try {
        fs.statSync(targetPath);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Normalizes line endings so comparison across Windows/Unix copies does not flag false diffs.
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
    return String(text || '').replace(/\r\n/g, '\n');
}

/**
 * Resolves a client flag string (`--client`) to a matching CLIENT_TARGETS entry or 'all'.
 * @param {string} clientArg
 * @returns {{ mode: 'all'|'single'|'unknown', client?: Object }}
 */
function resolveClientArg(clientArg) {
    const normalized = String(clientArg || '').trim().toLowerCase();
    if (!normalized) return { mode: 'unknown' };
    if (normalized === 'all') return { mode: 'all' };

    for (const client of CLIENT_TARGETS) {
        if (client.id === normalized || client.aliases.includes(normalized)) {
            return { mode: 'single', client };
        }
    }
    return { mode: 'unknown' };
}

/**
 * Resolves target file path and formatted display path for a client in the given scope.
 * @param {Object} client
 * @param {'global'|'workspace'} scope
 * @param {{ homeDir: string, cwd: string }} ctx
 * @returns {{ targetPath: string, displayPath: string }}
 */
function getClientTargetPaths(client, scope, { homeDir, cwd }) {
    if (scope === 'workspace') {
        const targetPath = path.resolve(client.workspaceSkillPath(cwd));
        const rel = path.relative(cwd, targetPath).replace(/\\/g, '/');
        return {
            targetPath,
            displayPath: rel.startsWith('..') ? rel : `./${rel}`
        };
    }

    const targetPath = path.resolve(client.globalSkillPath(homeDir));
    const relHome = path.relative(homeDir, targetPath).replace(/\\/g, '/');
    return {
        targetPath,
        displayPath: relHome && !relHome.startsWith('..') ? `~/${relHome}` : targetPath
    };
}

/**
 * Inspects installation status of `zzz/SKILL.md` at `targetPath` relative to `sourceContent`.
 * @param {string} targetPath
 * @param {string} sourceContent
 * @returns {'not_installed'|'up_to_date'|'differs'}
 */
function inspectInstallStatus(targetPath, sourceContent) {
    if (!pathExists(targetPath)) return 'not_installed';
    try {
        const existing = fs.readFileSync(targetPath, 'utf8');
        return normalizeText(existing) === normalizeText(sourceContent) ? 'up_to_date' : 'differs';
    } catch (e) {
        return 'differs';
    }
}

/**
 * Discovers installed AI coding harnesses on the machine (global) or current directory (workspace).
 * Deduplicates entries that resolve to the exact same destination path (e.g. Antigravity & Universal `.agents` in workspace scope).
 * @param {Object} [options]
 * @returns {Array<Object>}
 */
function discoverTargets(options = {}) {
    const scope = options.scope || 'global';
    const homeDir = options.homeDir || os.homedir();
    const cwd = options.cwd || process.cwd();
    const platform = options.platform || process.platform;
    const env = options.env || process.env;
    const sourcePath = options.skillSourcePath || DEFAULT_SKILL_SOURCE;
    const sourceContent = options.skillContent !== undefined
        ? options.skillContent
        : fs.readFileSync(sourcePath, 'utf8');

    const discovered = [];
    const seenPaths = new Set();

    for (const client of CLIENT_TARGETS) {
        const indicators = scope === 'workspace'
            ? client.detectWorkspaceDirs(cwd, platform, env)
            : client.detectGlobalDirs(homeDir, platform, env);

        const { targetPath, displayPath } = getClientTargetPaths(client, scope, { homeDir, cwd });
        const detected = indicators.some(pathExists) || pathExists(targetPath);
        if (!detected) continue;

        const dedupKey = targetPath.toLowerCase();
        if (seenPaths.has(dedupKey)) continue;
        seenPaths.add(dedupKey);

        discovered.push({
            client,
            scope,
            targetPath,
            displayPath,
            status: inspectInstallStatus(targetPath, sourceContent)
        });
    }

    return discovered;
}

/**
 * Formats a human-readable status tag for menu output.
 * @param {'not_installed'|'up_to_date'|'differs'} status
 * @returns {string}
 */
function formatStatusLabel(status) {
    if (status === 'up_to_date') return 'installed';
    if (status === 'differs') return 'update available';
    return 'not installed';
}

/**
 * Creates a buffered line prompter over `stdin` so consecutive questions never lose queued lines.
 * @param {NodeJS.ReadableStream} stdin
 * @param {NodeJS.WritableStream} stdout
 * @returns {{ ask: (questionText: string) => Promise<string>, close: () => void }}
 */
function createPrompter(stdin, stdout) {
    let rl = null;
    const lineQueue = [];
    const waiters = [];
    let closed = false;

    function ensureRl() {
        if (rl) return;
        rl = readline.createInterface({
            input: stdin,
            crlfDelay: Infinity
        });
        rl.on('line', (line) => {
            if (waiters.length > 0) {
                const resolve = waiters.shift();
                resolve(line.trim());
            } else {
                lineQueue.push(line.trim());
            }
        });
        rl.on('close', () => {
            closed = true;
            while (waiters.length > 0) {
                const resolve = waiters.shift();
                resolve('');
            }
        });
    }

    return {
        ask(questionText) {
            stdout.write(questionText);
            ensureRl();
            if (lineQueue.length > 0) {
                return Promise.resolve(lineQueue.shift());
            }
            if (closed) {
                return Promise.resolve('');
            }
            return new Promise((resolve) => {
                waiters.push(resolve);
            });
        },
        close() {
            if (rl) {
                rl.close();
                rl = null;
            }
        }
    };
}

/**
 * Parses comma-separated interactive menu selections (`1,3`, `A`, `Q`).
 * @param {string} input
 * @param {Array<Object>} candidates
 * @returns {{ action: 'quit'|'selected'|'invalid', targets: Array<Object> }}
 */
function parseMenuSelection(input, candidates) {
    const trimmed = String(input || '').trim();
    if (!trimmed || /^q(uit)?$/i.test(trimmed)) {
        return { action: 'quit', targets: [] };
    }
    if (/^a(ll)?$/i.test(trimmed)) {
        return { action: 'selected', targets: candidates.slice() };
    }

    const parts = trimmed.split(',').map((p) => p.trim()).filter(Boolean);
    const chosen = [];
    const seen = new Set();

    for (const part of parts) {
        if (!/^\d+$/.test(part)) {
            return { action: 'invalid', targets: [] };
        }
        const idx = parseInt(part, 10);
        if (idx < 1 || idx > candidates.length) {
            return { action: 'invalid', targets: [] };
        }
        const item = candidates[idx - 1];
        const key = item.targetPath.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            chosen.push(item);
        }
    }

    return chosen.length > 0
        ? { action: 'selected', targets: chosen }
        : { action: 'invalid', targets: [] };
}

/**
 * Writes `SKILL.md` atomically using a temporary swap file in the same directory.
 * @param {string} targetPath
 * @param {string} content
 */
function writeSkillAtomically(targetPath, content) {
    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${targetPath}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmpPath, content, 'utf8');
        fs.renameSync(tmpPath, targetPath);
    } catch (err) {
        try {
            fs.unlinkSync(tmpPath);
        } catch (cleanupErr) {
            // Ignore cleanup failure for missing temp file
        }
        throw err;
    }
}

/**
 * Removes an installed `SKILL.md` and cleans up its empty `zzz` skill directory.
 * @param {string} targetPath
 */
function removeSkillFile(targetPath) {
    fs.unlinkSync(targetPath);
    const skillDir = path.dirname(targetPath);
    try {
        if (fs.readdirSync(skillDir).length === 0) {
            fs.rmdirSync(skillDir);
        }
    } catch (e) {
        // Ignore non-empty or protected parent directory cleanup
    }
}

/**
 * Runs the interactive or scripted `/zzz` skill installer across AI coding clients.
 * @param {Object} [options]
 * @returns {Promise<{ success: boolean, cancelled?: boolean, results: Array<Object>, message: string }>}
 */
async function runSetup(options = {}) {
    const scope = (options.scope || 'global').toLowerCase();
    if (scope !== 'global' && scope !== 'workspace') {
        return {
            success: false,
            results: [],
            message: `Invalid scope "${options.scope}". Expected "global" or "workspace".`
        };
    }

    const homeDir = options.homeDir || os.homedir();
    const cwd = options.cwd || process.cwd();
    const platform = options.platform || process.platform;
    const env = options.env || process.env;
    const stdin = options.stdin || process.stdin;
    const stdout = options.stdout || process.stdout;
    const dryRun = !!options.dryRun;
    const force = !!options.force;
    const uninstall = !!options.uninstall;
    const jsonMode = !!options.json;
    const quiet = jsonMode || !!options.quiet;
    const logFn = quiet ? () => {} : (options.logFn || ((line) => stdout.write(`${line}\n`)));

    const sourcePath = options.skillSourcePath || DEFAULT_SKILL_SOURCE;
    let sourceContent = '';
    try {
        sourceContent = fs.readFileSync(sourcePath, 'utf8');
    } catch (err) {
        return {
            success: false,
            results: [],
            message: `Could not read bundled SKILL.md at ${sourcePath}: ${err.message}`
        };
    }

    if (!options.client && jsonMode) {
        return {
            success: false,
            results: [],
            message: 'Interactive setup cannot run with --json. Pass --client <name|all> with --json.'
        };
    }

    let targets = [];
    const interactiveMode = !options.client;
    const prompter = createPrompter(stdin, stdout);

    try {
        if (options.client) {
            const resolved = resolveClientArg(options.client);
            if (resolved.mode === 'unknown') {
                const validIds = CLIENT_TARGETS.map((c) => c.id).concat(['all']);
                return {
                    success: false,
                    results: [],
                    message: `Unknown client "${options.client}". Valid clients: ${validIds.join(', ')}`
                };
            }

            if (resolved.mode === 'all') {
                targets = discoverTargets({
                    scope,
                    homeDir,
                    cwd,
                    platform,
                    env,
                    skillSourcePath: sourcePath,
                    skillContent: sourceContent
                });
                if (targets.length === 0) {
                    return {
                        success: false,
                        results: [],
                        message: `No AI client configurations detected for ${scope} scope. Pass --client <name> to install explicitly.`
                    };
                }
            } else {
                const client = resolved.client;
                const { targetPath, displayPath } = getClientTargetPaths(client, scope, { homeDir, cwd });
                targets = [{
                    client,
                    scope,
                    targetPath,
                    displayPath,
                    status: inspectInstallStatus(targetPath, sourceContent)
                }];
            }
        } else {
            const detected = discoverTargets({
                scope,
                homeDir,
                cwd,
                platform,
                env,
                skillSourcePath: sourcePath,
                skillContent: sourceContent
            });

            if (detected.length === 0) {
                return {
                    success: false,
                    results: [],
                    message: `No installed AI client configurations detected for ${scope} scope. Use --client <name> (e.g. antigravity, claude-code, copilot, agents) to create one explicitly.`
                };
            }

            const isTTY = typeof options.isTTY === 'boolean' ? options.isTTY : !!stdin.isTTY;
            if (!isTTY) {
                return {
                    success: false,
                    results: [],
                    message: 'Interactive setup requires a terminal prompt. Re-run with --client <name> (or --client all).'
                };
            }

            const actionLabel = uninstall ? 'uninstall /zzz from' : 'install /zzz into';
            logFn('');
            logFn(`  agent-zzz skill setup (${scope} scope)`);
            logFn('  ──────────────────────────────────────────────────────────');
            detected.forEach((entry, idx) => {
                const badge = uninstall ? formatStatusLabel(entry.status) : `${entry.client.capability}; ${formatStatusLabel(entry.status)}`;
                logFn(`  ${idx + 1}) ${entry.client.name}`);
                logFn(`     ${entry.displayPath}  [${badge}]`);
            });
            logFn('  A) All detected clients');
            logFn('  Q) Quit\n');

            const answer = await prompter.ask(
                `Select client(s) to ${actionLabel} (number, comma-separated, 'A', or 'Q') [Q]: `
            );

            const parsed = parseMenuSelection(answer, detected);
            if (parsed.action === 'quit') {
                return {
                    success: true,
                    cancelled: true,
                    results: [],
                    message: 'Setup cancelled. No files were modified.'
                };
            }
            if (parsed.action === 'invalid') {
                return {
                    success: false,
                    results: [],
                    message: `Invalid selection "${answer}". Setup cancelled.`
                };
            }
            targets = parsed.targets;
        }

        const results = [];
        let hasFailures = false;

        for (const target of targets) {
            if (uninstall) {
                if (!pathExists(target.targetPath)) {
                    logFn(`[agent-zzz] ${target.client.name}: not installed at ${target.displayPath} (skipped).`);
                    results.push({ client: target.client.id, path: target.targetPath, action: 'skipped', reason: 'not_installed' });
                    continue;
                }
                if (dryRun) {
                    logFn(`[Dry Run] Would remove ${target.targetPath}`);
                    results.push({ client: target.client.id, path: target.targetPath, action: 'dry_run_uninstall' });
                    continue;
                }
                try {
                    removeSkillFile(target.targetPath);
                    logFn(`[agent-zzz] Removed /zzz skill from ${target.client.name}: ${target.targetPath}`);
                    results.push({ client: target.client.id, path: target.targetPath, action: 'uninstalled' });
                } catch (err) {
                    logFn(`[agent-zzz] Error removing ${target.targetPath}: ${err.message}`);
                    results.push({ client: target.client.id, path: target.targetPath, action: 'error', reason: err.message });
                    hasFailures = true;
                }
                continue;
            }

            if (target.status === 'up_to_date') {
                if (dryRun) {
                    logFn(`[Dry Run] ${target.client.name}: already up to date at ${target.targetPath}`);
                    results.push({ client: target.client.id, path: target.targetPath, action: 'up_to_date' });
                } else {
                    logFn(`[agent-zzz] ${target.client.name}: already up to date at ${target.targetPath}`);
                    results.push({ client: target.client.id, path: target.targetPath, action: 'up_to_date' });
                }
                continue;
            }

            if (target.status === 'differs' && !force) {
                if (dryRun) {
                    logFn(`[Dry Run] Would update existing skill at ${target.targetPath} (requires --force or confirmation)`);
                    results.push({ client: target.client.id, path: target.targetPath, action: 'dry_run_update' });
                    continue;
                }

                if (interactiveMode) {
                    const confirm = await prompter.ask(
                        `Existing skill differs at ${target.displayPath}. Overwrite? [y/N]: `
                    );
                    if (!/^y(es)?$/i.test(confirm)) {
                        logFn(`[agent-zzz] Skipped ${target.client.name} (${target.displayPath}).`);
                        results.push({ client: target.client.id, path: target.targetPath, action: 'skipped', reason: 'overwrite_declined' });
                        continue;
                    }
                } else {
                    logFn(`[agent-zzz] Error: existing SKILL.md differs at ${target.targetPath}. Pass --force to overwrite.`);
                    results.push({ client: target.client.id, path: target.targetPath, action: 'error', reason: 'exists_differs' });
                    hasFailures = true;
                    continue;
                }
            }

            if (dryRun) {
                logFn(`[Dry Run] Would install /zzz skill for ${target.client.name} -> ${target.targetPath}`);
                results.push({ client: target.client.id, path: target.targetPath, action: 'dry_run_install' });
                continue;
            }

            try {
                writeSkillAtomically(target.targetPath, sourceContent);
                const verb = target.status === 'differs' ? 'Updated' : 'Installed';
                logFn(`[agent-zzz] ${verb} /zzz skill for ${target.client.name}: ${target.targetPath}`);
                results.push({ client: target.client.id, path: target.targetPath, action: target.status === 'differs' ? 'updated' : 'installed' });
            } catch (err) {
                logFn(`[agent-zzz] Error writing ${target.targetPath}: ${err.message}`);
                results.push({ client: target.client.id, path: target.targetPath, action: 'error', reason: err.message });
                hasFailures = true;
            }
        }

        if (hasFailures) {
            return {
                success: false,
                results,
                message: force
                    ? 'Setup finished with write errors (check permissions or run outside sandbox).'
                    : 'Setup finished with skipped conflicts or write errors (pass --force to overwrite modified files).'
            };
        }

        return {
            success: true,
            results,
            message: dryRun ? 'Dry run complete.' : ''
        };
    } finally {
        prompter.close();
    }
}

module.exports = {
    CLIENT_TARGETS,
    DEFAULT_SKILL_SOURCE,
    resolveVSCodeCopilotStorageDir,
    resolveClientArg,
    getClientTargetPaths,
    inspectInstallStatus,
    discoverTargets,
    parseMenuSelection,
    runSetup
};
