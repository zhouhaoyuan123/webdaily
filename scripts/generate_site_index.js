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

// Build index.html — only show contents of targetDir; use <details> for nested folders (depth>0)
function renderIndex(changedPages, tree) {
    const title = 'Site Index';
    const topLinks = changedPages.map(p => {
        const href = targetPrefix ? `${targetPrefix}/${p}` : p;
        return `<li><a href="./${encodeURI(href)}">${href}</a></li>`;
    }).join('\n') || '<li>None in latest commit</li>';

    function renderTree(node, depth = 0) {
        let out = '';
        if (node.pages && node.pages.length) {
            out += '<ul>\n';
            for (const pg of node.pages) {
                const href = targetPrefix ? `${targetPrefix}/${pg.rel}` : pg.rel;
                out += `${' '.repeat(depth)}<li><a href="./${encodeURI(href)}">${href}</a></li>\n`;
            }
            out += '</ul>\n';
        }
        if (node.folders && node.folders.length) {
            out += '<ul>\n';
            for (const fd of node.folders) {
                if (depth === 0) {
                    // top-level (the 'webpages' root) — do not collapse
                    out += `${' '.repeat(depth)}<li><strong>${fd.name}/</strong>\n`;
                    out += renderTree(fd, depth + 1);
                    out += `${' '.repeat(depth)}</li>\n`;
                } else {
                    // nested folders — place contents in a details block to reduce page length
                    out += `${' '.repeat(depth)}<li><details><summary>${fd.name}/</summary>\n`;
                    out += renderTree(fd, depth + 1);
                    out += `${' '.repeat(depth)}</details></li>\n`;
                }
            }
            out += '</ul>\n';
        }
        return out;
    }

    const allPagesSection = renderTree(tree);

    // Show which folder is being displayed so it's clear (targetPrefix may be empty)
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

// Build sitemap.xml (only pages under targetDir)
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

function escapeXml(s) {
    return s.replace(/[<>&'"]/g, (c)=>({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]));
}

function renderRobots() {
    const sitemapUrl = baseUrl ? `${baseUrl}/sitemap.xml` : '/sitemap.xml';
    return `User-agent: *
Allow: /
Sitemap: ${sitemapUrl}
`;
}

// Write files (index remains at pagesDir root; it will point into targetPrefix if needed)
const indexPath = path.join(pagesDir, 'index.html');
const sitemapPath = path.join(pagesDir, 'sitemap.xml');
const robotsPath = path.join(pagesDir, 'robots.txt');

fs.writeFileSync(indexPath, renderIndex(changedPages, tree), 'utf8');
fs.writeFileSync(sitemapPath, renderSitemap(tree), 'utf8');
fs.writeFileSync(robotsPath, renderRobots(), 'utf8');

console.log('Generated:', indexPath, sitemapPath, robotsPath);
