'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./userscripts.config');

const projectRoot = path.resolve(__dirname, '..');
const checkOnly = process.argv.includes('--check');
const metadataPattern = /^(\/\/ ==UserScript==\n[\s\S]*?\n\/\/ ==\/UserScript==)\n*/;
const requiredMetadata = ['name', 'version', 'match', 'grant', 'updateURL', 'downloadURL'];

function normalizeText(value) {
  return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function readProjectFile(relativePath) {
  const absolutePath = path.resolve(projectRoot, relativePath);
  const relativeFromRoot = path.relative(projectRoot, absolutePath);
  if (relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
    throw new Error(`Caminho fora do projeto: ${relativePath}`);
  }
  return normalizeText(fs.readFileSync(absolutePath, 'utf8'));
}

function splitUserscriptSource(relativePath) {
  const source = readProjectFile(relativePath);
  const match = source.match(metadataPattern);
  if (!match) {
    throw new Error(`${relativePath} precisa começar com um bloco UserScript válido.`);
  }

  for (const key of requiredMetadata) {
    const directive = new RegExp(`^//\\s+@${key}\\s+\\S+`, 'm');
    if (!directive.test(match[1])) {
      throw new Error(`${relativePath} não possui @${key}.`);
    }
  }

  const body = source.slice(match[0].length).trim();
  if (!body) throw new Error(`${relativePath} não possui código após o metadata.`);
  return { metadata: match[1], body };
}

function buildUserscript(entry) {
  if (!entry.output.endsWith('.user.js')) {
    throw new Error(`Output precisa terminar em .user.js: ${entry.output}`);
  }

  const { metadata, body } = splitUserscriptSource(entry.input);
  const sharedPaths = [...new Set([...(config.shared || []), ...(entry.shared || [])])];
  const sharedModules = sharedPaths.map((relativePath) => {
    const source = readProjectFile(relativePath).trim();
    if (!source) throw new Error(`Módulo compartilhado vazio: ${relativePath}`);
    return `// Shared module: ${relativePath}\n${source}`;
  });
  const chunks = sharedModules.length > 0 ? [...sharedModules, body] : [body];

  return [
    metadata,
    '',
    '// Arquivo gerado por scripts/build-userscripts.js. Não edite manualmente.',
    `// Fonte: ${entry.input}`,
    '',
    chunks.join('\n\n'),
    '',
  ].join('\n');
}

function writeOrCheck(entry, generated) {
  const outputPath = path.resolve(projectRoot, entry.output);
  const current = fs.existsSync(outputPath)
    ? normalizeText(fs.readFileSync(outputPath, 'utf8'))
    : null;

  if (current === generated) {
    console.log(`ok ${entry.output}`);
    return true;
  }

  if (checkOnly) {
    console.error(`desatualizado ${entry.output}`);
    return false;
  }

  fs.writeFileSync(outputPath, generated, 'utf8');
  console.log(`gerado ${entry.output}`);
  return true;
}

function main() {
  const outputs = new Set();
  let valid = true;

  for (const entry of config.userscripts) {
    if (outputs.has(entry.output)) throw new Error(`Output duplicado: ${entry.output}`);
    outputs.add(entry.output);
    valid = writeOrCheck(entry, buildUserscript(entry)) && valid;
  }

  if (!valid) {
    console.error('Execute npm run build e inclua os artefatos regenerados.');
    process.exitCode = 1;
  }
}

main();
