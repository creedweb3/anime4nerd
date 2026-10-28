// Zip dist/ into "Anime4Nerd prod.zip" with forward-slash entry names (required by the Chrome Web Store),
// then print its SHA-256 so a downloader can verify it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';

const version = JSON.parse(readFileSync('manifest.json', 'utf8')).version;
// --firefox zips dist-firefox/ for addons.mozilla.org instead.
const firefox = process.argv.includes('--firefox');
const dir = firefox ? 'dist-firefox' : 'dist';
const out = firefox ? 'Anime4Nerd firefox.zip' : 'Anime4Nerd prod.zip';
if (existsSync(out)) rmSync(out);
// bsdtar ships with Windows 10+ and macOS; -a picks the format from the .zip extension.
// On Windows use System32's bsdtar explicitly: Git-for-Windows puts GNU tar first on PATH, which cannot write zip.
const tar = process.platform === 'win32' ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\tar.exe` : 'tar';
execFileSync(tar, ['-a', '-c', '-f', `../${out}`, '*'], { cwd: dir, stdio: 'inherit', shell: false });
const sha = createHash('sha256').update(readFileSync(out)).digest('hex');
writeFileSync(`${out}.sha256`, `${sha}  ${out}\n`);
console.log(`wrote ${out} (v${version})\nsha256 ${sha}`);
