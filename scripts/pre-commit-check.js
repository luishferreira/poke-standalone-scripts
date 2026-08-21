'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('./userscripts.config');

const projectRoot = path.resolve(__dirname, '..');
const safeProjectRoot = projectRoot.replace(/\\/g, '/');
const buildFiles = new Set([
  'package.json',
  'scripts/build-userscripts.js',
  'scripts/userscripts.config.js',
]);
const globalSharedFiles = new Set(config.shared || []);
const entries = config.userscripts.map((entry) => {
  const shared = [...globalSharedFiles, ...(entry.shared || [])];
  return { ...entry, shared };
});
const sharedFiles = new Set(entries.flatMap((entry) => entry.shared));
const relevantFiles = new Set([
  ...buildFiles,
  ...sharedFiles,
  ...entries.flatMap((entry) => [entry.input, entry.output]),
]);

function run(command, args, { inherit = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: false,
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const details = String(result.stderr || result.stdout || '').trim();
    throw new Error(details || `${command} encerrou com código ${result.status}.`);
  }
  return result;
}

function git(args, options) {
  return run('git', ['-c', `safe.directory=${safeProjectRoot}`, ...args], options);
}

function listPaths(args) {
  return new Set(
    git(args).stdout
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function readGitFile(spec) {
  const result = git(['show', spec], { allowFailure: true });
  return result.status === 0 ? result.stdout.replace(/\r\n?/g, '\n') : null;
}

function extractVersion(source, label) {
  const version = source?.match(/^\/\/\s+@version\s+(\S+)/m)?.[1];
  if (!version) throw new Error(`${label} não possui @version válido.`);
  return version;
}

function compareVersions(left, right) {
  const leftParts = left.match(/\d+/g)?.map(Number) || [];
  const rightParts = right.match(/\d+/g)?.map(Number) || [];
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function fail(messages) {
  console.error('\nPre-commit recusado:');
  for (const message of messages) console.error(`- ${message}`);
  console.error('\nCorrija, execute npm run build, adicione os arquivos e tente novamente.');
  process.exitCode = 1;
}

function main() {
  console.log('Verificando userscripts antes do commit...');
  const verification = process.platform === 'win32'
    ? run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run verify'], {
        inherit: true,
        allowFailure: true,
      })
    : run('npm', ['run', 'verify'], {
        inherit: true,
        allowFailure: true,
      });
  if (verification.status !== 0) {
    fail(['npm run verify falhou.']);
    return;
  }

  const staged = listPaths(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
  if (staged.size === 0) {
    console.log('Nenhuma alteração staged; verificação do workspace aprovada.');
    return;
  }
  const unstaged = listPaths(['diff', '--name-only']);
  const problems = [];

  for (const relativePath of unstaged) {
    if (relevantFiles.has(relativePath)) {
      problems.push(`${relativePath} possui alterações não adicionadas ao commit.`);
    }
  }

  for (const entry of entries) {
    const influencers = new Set([entry.input, ...entry.shared, ...buildFiles]);
    const sourceChanged = [...influencers].some((relativePath) => staged.has(relativePath));
    const outputChanged = staged.has(entry.output);
    const outputDiffersFromHead = git(
      ['diff', '--quiet', 'HEAD', '--', entry.output],
      { allowFailure: true },
    ).status !== 0;

    if (sourceChanged && outputDiffersFromHead && !outputChanged) {
      problems.push(`${entry.output} precisa ser adicionado junto das fontes que o alteraram.`);
    }
    if (outputChanged && !sourceChanged) {
      problems.push(`${entry.output} mudou sem sua fonte ou configuração de build no commit.`);
    }
    if (!outputChanged) continue;

    const stagedSource = readGitFile(`:${entry.input}`);
    const headSource = readGitFile(`HEAD:${entry.input}`);
    if (!stagedSource || !headSource) continue;
    const stagedVersion = extractVersion(stagedSource, `staged ${entry.input}`);
    const headVersion = extractVersion(headSource, `HEAD ${entry.input}`);
    if (compareVersions(stagedVersion, headVersion) <= 0) {
      problems.push(
        `${entry.input} precisa aumentar @version acima de ${headVersion} ` +
        `(versão staged: ${stagedVersion}).`,
      );
    }
  }

  if (problems.length > 0) {
    fail(problems);
    return;
  }
  console.log('Pre-commit aprovado.');
}

try {
  main();
} catch (error) {
  fail([error?.message || String(error)]);
}
