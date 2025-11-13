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

// locate the target folder named 'webpages' (use it if present), otherwise use pagesDir
const targetFolderName = 'webpages';
let targetDir = path.join(pagesDir, targetFolderName);
if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    targetDir = pagesDir;
}
const targetPrefix = toWebPath(path.relative(pagesDir, targetDir)); // e.g. 'webpages' or ''

// Helper to normalize for web links
function toWebPath(p) {
    return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

// Get files changed in latest commit
let changedFiles = [];
try {
    const raw = run('git diff-tree --no-commit-id --name-only -r HEAD');
    changedFiles = raw.split('\n').filter(Boolean);
} catch (e) {
    // If no commits or other error, leave empty
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

// collect all folder nodes with their relative paths
function collectFolderNodes(node, rel = '') {
    const list = [];
    // node corresponds to rel ('' for the current base)
    for (const fd of node.folders || []) {
        const childRel = rel ? `${rel}/${fd.name}` : fd.name;
        list.push({ rel: childRel, node: fd });
        list.push(...collectFolderNodes(fd, childRel));
    }
    return list;
}

function safeName(rel) {
    if (!rel) return '__root';
    return rel.replace(/[\/\\]/g, '_').replace(/\s+/g, '_');
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// create indexes folder
const indexesDir = path.join(pagesDir, 'indexes');
ensureDir(indexesDir);

// render a per-folder index HTML
function renderFolderIndex(folderRel, folderNode) {
    const title = `Index for ${folderRel}`;
    const listPages = (folderNode.pages || []).map(pg => {
        const href = (targetPrefix ? `${targetPrefix}/${pg.rel}` : pg.rel);
        return `<li><a href="./${encodeURI(href)}">${href}</a></li>`;
    }).join('\n') || '<li>(no pages)</li>';

    const listFolders = (folderNode.folders || []).map(fd => {
        const childRel = folderRel ? `${folderRel}/${fd.name}` : fd.name;
        const childSafe = safeName(childRel);
        return `<li><a href="./indexes/${childSafe}.html">${fd.name}/</a></li>`;
    }).join('\n') || '<li>(no subfolders)</li>';

    return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body>
<h1>${title}</h1>
<section><h2>Pages</h2><ul>${listPages}</ul></section>
<section><h2>Subfolders</h2><ul>${listFolders}</ul></section>
</body>
</html>`;
}

// render sitemap for a folder (including nested pages)
function collectPagesUnder(node, baseRel = '') {
    let out = [];
    for (const p of node.pages || []) out.push((baseRel ? `${baseRel}/${p.rel}` : p.rel));
    for (const fd of node.folders || []) {
        const childRel = baseRel ? `${baseRel}/${fd.name}` : fd.name;
        out = out.concat(collectPagesUnder(fd, childRel));
    }
    return out;
}

function renderSitemapForFolder(folderRel, pagesList) {
    const urls = pagesList.map(p => {
        const urlPath = targetPrefix ? `${targetPrefix}/${p}` : p;
        const href = baseUrl ? `${baseUrl}/${urlPath}` : `/${urlPath}`;
        return `<url><loc>${escapeXml(href)}</loc></url>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

// XML escaper used by sitemap builders
function escapeXml(s) {
    return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

// Fallback sitemap renderer for the legacy sitemap.xml (collects all pages under the target tree)
function renderSitemap(tree) {
    const pages = [];
    function collect(node) {
        if (node.pages) for (const p of node.pages) pages.push(p.rel);
        if (node.folders) for (const f of node.folders) collect(f);
    }
    collect(tree);
    const urls = pages.map(p => {
        const urlPath = targetPrefix ? `${targetPrefix}/${p}` : p;
        const href = baseUrl ? `${baseUrl}/${urlPath}` : `/${urlPath}`;
        return `<url><loc>${escapeXml(href)}</loc></url>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

// create per-folder files
const folderNodes = collectFolderNodes(tree, '');
const sitemapFiles = [];

for (const f of folderNodes) {
    const rel = f.rel; // e.g. "blog/posts"
    const node = f.node;
    const name = safeName(rel);
    const indexHtml = renderFolderIndex(rel, node);
    const indexPathLocal = path.join(indexesDir, `${name}.html`);
    fs.writeFileSync(indexPathLocal, indexHtml, 'utf8');

    // sitemap for this folder (include nested pages)
    const pagesList = collectPagesUnder(node, '');
    const sitemapContent = renderSitemapForFolder(rel, pagesList);
    const sitemapName = `sitemap_${name}.xml`;
    const sitemapPathLocal = path.join(pagesDir, sitemapName);
    fs.writeFileSync(sitemapPathLocal, sitemapContent, 'utf8');
    sitemapFiles.push(sitemapName);
}

// Also create a sitemap for the root targetDir (pages directly under targetDir)
const rootPages = collectPagesUnder(tree, '');
const rootSitemapName = `sitemap_root.xml`;
fs.writeFileSync(path.join(pagesDir, rootSitemapName), renderSitemapForFolder('', rootPages), 'utf8');
sitemapFiles.unshift(rootSitemapName);

// Build sitemap index referencing all sitemap files
function renderSitemapIndex(sitemaps) {
    const entries = sitemaps.map(s => {
        const href = baseUrl ? `${baseUrl}/${s}` : `/${s}`;
        return `<sitemap><loc>${escapeXml(href)}</loc></sitemap>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</sitemapindex>`;
}
const sitemapIndexPath = path.join(pagesDir, 'sitemap_index.xml');
fs.writeFileSync(sitemapIndexPath, renderSitemapIndex(sitemapFiles), 'utf8');

// Update robots to reference sitemap_index.xml
function renderRobots() {
    const sitemapUrl = baseUrl ? `${baseUrl}/sitemap_index.xml` : '/sitemap_index.xml';
    return `User-agent: *
Allow: /
Sitemap: ${sitemapUrl}
`;
}

// Build index.html — only show contents of targetDir; use <details> for nested folders (depth>0)
function renderIndex(changedPages, tree) {
    const title = 'Site Index';
    const topLinks = changedPages.map(p => {
        const href = targetPrefix ? `${targetPrefix}/${p}` : p;
        return `<li><a href="./${encodeURI(href)}">${href}</a></li>`;
    }).join('\n') || '<li>None in latest commit</li>';

    function renderTree(node, depth = 0, relPrefix = '') {
        let out = '';
        if (node.pages && node.pages.length) {
            out += '<ul>\n';
            for (const pg of node.pages) {
                const href = targetPrefix ? `${targetPrefix}/${(relPrefix ? relPrefix + '/' : '')}${pg.rel}` : `${(relPrefix ? relPrefix + '/' : '')}${pg.rel}`;
                out += `${' '.repeat(depth)}<li><a href="./${encodeURI(href)}">${href}</a></li>\n`;
            }
            out += '</ul>\n';
        }
        if (node.folders && node.folders.length) {
            out += '<ul>\n';
            for (const fd of node.folders) {
                const childRel = relPrefix ? `${relPrefix}/${fd.name}` : fd.name;
                if (depth === 0) {
                    // top-level — do not collapse
                    out += `${' '.repeat(depth)}<li><strong>${fd.name}/</strong>\n`;
                    out += renderTree(fd, depth + 2, childRel);
                    out += `${' '.repeat(depth)}</li>\n`;
                } else {
                    // nested folders — collapse with details
                    out += `${' '.repeat(depth)}<li><details><summary>${fd.name}/</summary>\n`;
                    out += renderTree(fd, depth + 2, childRel);
                    out += `${' '.repeat(depth)}</details></li>\n`;
                }
            }
            out += '</ul>\n';
        }
        return out;
    }

    const allPagesSection = renderTree(tree, 0, '');

    const shownRootLabel = targetPrefix || path.basename(pagesDir);

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
</head>
<body>
<h1>${title} — showing: ${shownRootLabel}</h1>
<section>
  <h2>Recently edited (latest commit)</h2>
  <ul>
    ${topLinks}
  </ul>
</section>
<section>
  <h2>Folders & Pages under ${shownRootLabel}</h2>
  ${allPagesSection}
</section>
</body>
</html>`;
}

// Write files (index remains at pagesDir root; it will point into targetPrefix if needed)
const indexPath = path.join(pagesDir, 'index.html');
const sitemapPath = path.join(pagesDir, 'sitemap.xml'); // optional legacy
const robotsPath = path.join(pagesDir, 'robots.txt');

fs.writeFileSync(indexPath, renderIndex(changedPages, tree), 'utf8');
// keep legacy sitemap.xml for backward compatibility (root sitemap)
fs.writeFileSync(sitemapPath, renderSitemap(tree), 'utf8');
fs.writeFileSync(robotsPath, renderRobots(), 'utf8');

console.log('Generated:', indexPath, sitemapPath, robotsPath, sitemapIndexPath, 'indexes/', sitemapFiles.join(','));
