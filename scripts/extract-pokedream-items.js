'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SITE_URL = 'https://pokedream.com.br/';
const MANIFEST_URL = new URL('/assets-manifest.json', SITE_URL);
const OUTPUT_PATH = path.resolve(__dirname, '..', 'data', 'pokedream-items.json');
const CATALOG_ANCHOR = 'small_potion:{id:"small_potion"';

async function fetchText(url) {
  const response = await fetch(url, { headers: { Accept: 'text/html,application/json,*/*' } });
  if (!response.ok) throw new Error(`Falha ao baixar ${url}: HTTP ${response.status}`);
  return response.text();
}

function findCatalogLiteral(source) {
  const anchorIndex = source.indexOf(CATALOG_ANCHOR);
  if (anchorIndex < 0) throw new Error('Âncora do catálogo de itens não encontrada na build.');

  const declarationPattern = /const\s+([A-Za-z_$][\w$]*)=\{/g;
  let declaration = null;
  for (const match of source.matchAll(declarationPattern)) {
    if (match.index > anchorIndex) break;
    declaration = match;
  }
  if (!declaration) throw new Error('Início do catálogo de itens não encontrado.');

  const start = declaration.index + declaration[0].length - 1;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('Fim do catálogo de itens não encontrado.');
}

function parseCatalog(literal) {
  const catalog = vm.runInNewContext(`(${literal})`, Object.create(null), {
    timeout: 1_000,
    codeGeneration: { strings: false, wasm: false },
  });
  const entries = Object.entries(catalog || {});
  if (entries.length < 100) throw new Error(`Catálogo incompleto: somente ${entries.length} itens.`);
  for (const [key, item] of entries) {
    if (!item || typeof item !== 'object' || item.id !== key || typeof item.kind !== 'string') {
      throw new Error(`Item inválido no catálogo: ${key}`);
    }
  }
  return catalog;
}

function summarize(catalog) {
  const items = Object.values(catalog);
  const byKind = {};
  for (const item of items) byKind[item.kind] = (byKind[item.kind] || 0) + 1;
  return {
    total: items.length,
    byKind,
    buyable: items.filter((item) => Number(item.buy) > 0).length,
    sellable: items.filter((item) => Number(item.sell) > 0).length,
  };
}

async function main() {
  const [html, manifestText] = await Promise.all([
    fetchText(SITE_URL),
    fetchText(MANIFEST_URL),
  ]);
  const assetMatch = html.match(/assets\/[A-Za-z0-9_-]+\.js/);
  if (!assetMatch) throw new Error('Módulo principal não encontrado no HTML do jogo.');
  const assetUrl = new URL(assetMatch[0], SITE_URL);
  const [source, manifest] = await Promise.all([
    fetchText(assetUrl),
    Promise.resolve(JSON.parse(manifestText)),
  ]);
  const catalog = parseCatalog(findCatalogLiteral(source));
  const output = {
    schemaVersion: 1,
    source: {
      site: SITE_URL,
      buildId: manifest.buildId || null,
      asset: assetUrl.pathname,
      extractedAt: new Date().toISOString(),
    },
    summary: summarize(catalog),
    items: catalog,
  };
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`gerado ${path.relative(path.resolve(__dirname, '..'), OUTPUT_PATH)} (${output.summary.total} itens)`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
