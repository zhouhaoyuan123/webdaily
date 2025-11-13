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

// Get files changed in latest commit
let changedFiles = [];
try {
    const raw = run('git diff-tree --no-commit-id --name-only -r HEAD');
    changedFiles = raw.split('\n').filter(Boolean);
} catch (e) {
    // If no commits or other error, leave empty
    changedFiles = [];
}

// Filter changed files that live inside pagesDir
const changedPages = changedFiles
    .map(f => path.resolve(repoRoot, f))
    .filter(abs => abs.startsWith(pagesDir))
    .map(abs => toWebPath(path.relative(pagesDir, abs)))
    .filter(p => p.toLowerCase().endsWith('.html'));

// Recursively list folders and html pages under pagesDir
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

const tree = walk(pagesDir, pagesDir);

// Build index.html
function renderIndex(changedPages, tree) {
    const title = 'Site Index';
    const topLinks = changedPages.map(p => `<li><a href="./${encodeURI(p)}">${p}</a></li>`).join('\n') || '<li>None in latest commit</li>';
    function renderTree(node, indent = 0) {
        let out = '';
        if (node.pages && node.pages.length) {
            out += '<ul>\n';
            for (const pg of node.pages) {
                out += `${' '.repeat(indent)}<li><a href="./${encodeURI(pg.rel)}">${pg.rel}</a></li>\n`;
            }
            out += '</ul>\n';
        }
        if (node.folders && node.folders.length) {
            out += '<ul>\n';
            for (const fd of node.folders) {
                out += `${' '.repeat(indent)}<li><strong>${fd.name}/</strong>\n`;
                out += renderTree(fd, indent + 2);
                out += `${' '.repeat(indent)}</li>\n`;
            }
            out += '</ul>\n';
        }
        return out;
    }

    const allPagesSection = renderTree(tree);

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
</head>
<body>
<h1>${title}</h1>
<section>
  <h2>Recently edited (latest commit)</h2>
  <ul>
    ${topLinks}
  </ul>
</section>
<section>
  <h2>Folders & Pages</h2>
  ${allPagesSection}
</section>
</body>
</html>`;
}

// Build sitemap.xml (simple)
function renderSitemap(tree) {
    const pages = [];
    function collect(node) {
        if (node.pages) for (const p of node.pages) pages.push(p.rel);
        if (node.folders) for (const f of node.folders) collect(f);
    }
    collect(tree);
    const urls = pages.map(p => {
        const href = baseUrl ? `${baseUrl}/${p}` : `/${p}`;
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

// Write files
const indexPath = path.join(pagesDir, 'index.html');
const sitemapPath = path.join(pagesDir, 'sitemap.xml');
const robotsPath = path.join(pagesDir, 'robots.txt');

fs.writeFileSync(indexPath, renderIndex(changedPages, tree), 'utf8');
fs.writeFileSync(sitemapPath, renderSitemap(tree), 'utf8');
fs.writeFileSync(robotsPath, renderRobots(), 'utf8');

console.log('Generated:', indexPath, sitemapPath, robotsPath);
