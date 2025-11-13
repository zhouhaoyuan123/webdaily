const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd) {
    return execSync(cmd, { encoding: 'utf8' }).trim();
}

// Base settings
const repoRoot = run('git rev-parse --show-toplevel');
const pagesDir = process.cwd(); // run this script with working-directory set to the pages folder
const baseUrl = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/$/, '') : ''; // optional env

// Helper to normalize for web links
function toWebPath(p) {
    return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

// locate the target folder named 'webpages' (use it if present), otherwise use pagesDir
const targetFolderName = 'webpages';
let targetDir = path.join(pagesDir, targetFolderName);
if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    targetDir = pagesDir;
}
const targetPrefix = toWebPath(path.relative(pagesDir, targetDir)); // e.g. 'webpages' or ''

// Get files changed in latest commit
let changedFiles = [];
try {
    const raw = run('git diff-tree --no-commit-id --name-only -r HEAD');
    changedFiles = raw.split('\n').filter(Boolean);
} catch (e) {
    changedFiles = [];
}

// Filter changed files that live inside targetDir (not the whole pagesDir)
const changedPages = changedFiles
    .map(f => path.resolve(repoRoot, f))
    .filter(abs => abs.startsWith(targetDir))
    .map(abs => toWebPath(path.relative(targetDir, abs)))
    .filter(p => p.toLowerCase().endsWith('.html'));

// Recursively list folders and html pages under a given base (we'll call with targetDir)
function walk(dir, base) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const folders = [];
    const pages = [];
    for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const full = path.join(dir, ent.name);
        const rel = path.relative(base, full);
        if (ent.isDirectory()) {
            const sub = walk(full, base);
            folders.push({ name: ent.name, rel: toWebPath(rel), ...sub });
        } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.html')) {
            pages.push({ name: ent.name, rel: toWebPath(rel) });
        }
    }
    // sort for stability
    folders.sort((a,b)=>a.name.localeCompare(b.name));
    pages.sort((a,b)=>a.name.localeCompare(b.name));
    return { folders, pages };
}

const tree = walk(targetDir, targetDir);

// helpers
function safeName(rel) {
    if (!rel) return '__root';
    return rel.replace(/[\/\\]/g, '_').replace(/\s+/g, '_');
}
function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function escapeXml(s) {
    return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

// collect folder nodes (including root)
function collectFolderNodes(node, rel = '') {
    const list = [{ rel, node }];
    for (const fd of node.folders || []) {
        const childRel = rel ? `${rel}/${fd.name}` : fd.name;
        list.push(...collectFolderNodes(fd, childRel));
    }
    return list;
}

// create folders for auxiliary outputs
const sitemapsDir = path.join(pagesDir, 'sitemaps');
ensureDir(sitemapsDir);

// collect folder nodes
const folderNodes = collectFolderNodes(tree, '');

// Create latest_changes.html in pages root (links relative to pages root)
function renderLatestChanges(changedPagesList) {
    const title = 'Latest Changes';
    const items = changedPagesList.length ? changedPagesList.map(p => {
        const href = targetPrefix ? `${targetPrefix}/${p}` : p;
        return `<li><a href="./${encodeURI(href)}">${href}</a></li>`;
    }).join('\n') : '<li>None in latest commit</li>';
    return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body>
<h1>${title}</h1>
<section><ul>${items}</ul></section>
</body>
</html>`;
}
const latestPath = path.join(pagesDir, 'latest_changes.html');
fs.writeFileSync(latestPath, renderLatestChanges(changedPages), 'utf8');

// Utility to collect pages under a node (relative paths within targetDir)
function collectPagesUnder(node, baseRel = '') {
    let out = [];
    for (const p of node.pages || []) out.push((baseRel ? `${baseRel}/${p.rel}` : p.rel));
    for (const fd of node.folders || []) {
        const childRel = baseRel ? `${baseRel}/${fd.name}` : fd.name;
        out = out.concat(collectPagesUnder(fd, childRel));
    }
    return out;
}

// render sitemap for a folder (pagesList are relative to targetDir)
// changed: do not emit leading '/' when baseUrl is not set
function renderSitemapForFolder(folderRel, pagesList) {
    const urls = pagesList.map(p => {
        const urlPath = targetPrefix ? `${targetPrefix}/${p}` : p;
        const href = baseUrl ? `${baseUrl}/${urlPath}` : `${urlPath}`; // no leading slash when baseUrl absent
        return `<url><loc>${escapeXml(href)}</loc></url>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

// Create a sitemap for each non-root folder and write into sitemapsDir
const sitemapFiles = [];
for (const f of folderNodes) {
    const rel = f.rel; // '' for root
    if (!rel) continue; // skip root folder sitemap (avoid sitemap___root.xml)
    const node = f.node;
    const name = safeName(rel);
    const pagesList = collectPagesUnder(node, '');
    const sitemapContent = renderSitemapForFolder(rel, pagesList);
    const sitemapName = `sitemap_${name}.xml`;
    const sitemapPathLocal = path.join(sitemapsDir, sitemapName);
    fs.writeFileSync(sitemapPathLocal, sitemapContent, 'utf8');
    sitemapFiles.push(toWebPath(path.relative(pagesDir, sitemapPathLocal))); // e.g. "sitemaps/sitemap_xxx.xml"
}

// Build sitemap index referencing all sitemap files (which are in sitemaps/)
// changed: do not use leading '/' for sitemap paths when baseUrl not set
function renderSitemapIndex(sitemaps) {
    const entries = sitemaps.map(s => {
        const href = baseUrl ? `${baseUrl}/${s}` : `${s}`; // no leading slash if baseUrl absent
        return `<sitemap><loc>${escapeXml(href)}</loc></sitemap>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</sitemapindex>`;
}
const sitemapIndexPath = path.join(pagesDir, 'sitemap.xml'); // root sitemap.xml as index of per-folder sitemaps
fs.writeFileSync(sitemapIndexPath, renderSitemapIndex(sitemapFiles), 'utf8');
fs.writeFileSync(path.join(pagesDir, 'sitemap_index.xml'), renderSitemapIndex(sitemapFiles), 'utf8');

// Create index.html inside every folder under targetDir (including targetDir root)
function renderDirIndex(folderRel, folderNode, dirAbsolutePath) {
    // relative path from this directory to pagesDir root (so we can link latest_changes.html)
    const relToRoot = toWebPath(path.relative(dirAbsolutePath, pagesDir) || '.');
    const latestHref = relToRoot === '.' ? './latest_changes.html' : `${relToRoot}/latest_changes.html`;

    const title = `Index for ${folderRel || '/'}`;
    // files in this folder (folderNode.pages contain filenames relative to this folder)
    const filesList = (folderNode.pages || []).map(pg => {
        const href = `./${encodeURI(pg.name)}`;
        return `<li><a href="${href}">${pg.name}</a></li>`;
    }).join('\n') || '<li>(no pages)</li>';

    // subfolders inside this folder
    const subfoldersList = (folderNode.folders || []).map(fd => {
        const href = `./${fd.name}/`; // link to folder root; users can open its index.html
        return `<li><a href="${href}">${fd.name}/</a></li>`;
    }).join('\n') || '<li>(no subfolders)</li>';

    // Back link to parent: if this folder is targetDir root, back goes to pagesDir root index (pagesDir/index.html)
    let backHref = null;
    if (folderRel) {
        // inside a subfolder; parent is one level up
        backHref = '../';
    } else {
        // at targetDir root -> back to pagesDir root index (pagesDir/index.html)
        backHref = toWebPath(path.relative(dirAbsolutePath, pagesDir) || '.') + '/';
        // normalize
        if (backHref === './') backHref = './';
    }

    return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body>
<p><a href="${latestHref}">Latest changes</a></p>
<h1>${title}</h1>
<section><h2>Files</h2><ul>${filesList}</ul></section>
<section><h2>Subfolders</h2><ul>${subfoldersList}</ul></section>
<p><a href="${backHref}">Back</a></p>
</body>
</html>`;
}

// write index.html into each folder
for (const f of folderNodes) {
    const rel = f.rel; // '' for root
    const node = f.node;
    const dirAbs = rel ? path.join(targetDir, rel) : targetDir;
    const indexHtml = renderDirIndex(rel, node, dirAbs);
    const indexPathLocal = path.join(dirAbs, 'index.html');
    fs.writeFileSync(indexPathLocal, indexHtml, 'utf8');
}

// Also update the main pagesDir/index.html (overview) to link into targetPrefix and to latest_changes
function renderOverviewIndex(changedPages, tree) {
    const title = 'Site Index (overview)';
    const latestLink = './latest_changes.html';
    // top changed pages list (links relative to pages root)
    const topLinks = changedPages.map(p => {
        const href = targetPrefix ? `${targetPrefix}/${p}` : p;
        return `<li><a href="./${encodeURI(href)}">${href}</a></li>`;
    }).join('\n') || '<li>None in latest commit</li>';

    // Instead of rendering the entire folder tree inline, provide a single link to the directory index
    const dirIndexHref = targetPrefix ? `./${targetPrefix}/` : './';

    const shownRootLabel = targetPrefix || path.basename(pagesDir);

    return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body>
<h1>${title} — showing: ${shownRootLabel}</h1>
<p><a href="${latestLink}">Latest changes</a></p>
<section>
  <h2>Recently edited (latest commit)</h2>
  <ul>
    ${topLinks}
  </ul>
</section>
<section>
  <h2>Open directory</h2>
  <p><a href="${dirIndexHref}">Open directory index for ${shownRootLabel}</a></p>
</section>
</body>
</html>`;
}

const overviewIndexPath = path.join(pagesDir, 'index.html');
fs.writeFileSync(overviewIndexPath, renderOverviewIndex(changedPages, tree), 'utf8');

// write robots (point to root sitemap.xml)
function renderRobots() {
    const sitemapUrl = baseUrl ? `${baseUrl}/sitemap.xml` : '/sitemap.xml';
    return `User-agent: *
Allow: /
Sitemap: ${sitemapUrl}
`;
}
fs.writeFileSync(path.join(pagesDir, 'robots.txt'), renderRobots(), 'utf8');

console.log('Generated overview index, latest_changes.html, per-folder index.html files and sitemaps in', sitemapsDir);
