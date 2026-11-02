'use strict';
// Release build:
//   dist/CoFisher/CoFisher.exe            the app (single exe; uses the WebView2 built into Win10/11)
//   dist/relay/cofisher-relay             Linux relay (static, for a cloud server)
//   dist/relay/cofisher-relay.exe         Windows relay
//   dist/relay/install-relay.sh + .service
//   dist/CoFisher.zip, dist/cofisher-relay.zip
// Run: node tools/release.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
const mb = (f) => `${(fs.statSync(f).size / 1024 / 1024).toFixed(2)} MB`;

run('cargo', ['build', '--release', '-p', 'co-fisher', '-p', 'cofisher-server']);
run('cargo', ['build', '--release', '-p', 'cofisher-server', '--bin', 'cofisher-relay', '--target', 'x86_64-unknown-linux-musl']);

const appDir = path.join(dist, 'CoFisher');
const relayDir = path.join(dist, 'relay');
// Only our own outputs: dist/ may hold other things (e.g. an older copy that's running).
for (const p of [appDir, relayDir, path.join(dist, 'CoFisher.zip'), path.join(dist, 'cofisher-relay.zip')]) {
  fs.rmSync(p, { recursive: true, force: true });
}
fs.mkdirSync(appDir, { recursive: true });
fs.mkdirSync(relayDir, { recursive: true });

fs.copyFileSync(path.join(root, 'target', 'release', 'CoFisher.exe'), path.join(appDir, 'CoFisher.exe'));
fs.copyFileSync(path.join(root, 'target', 'release', 'steam_api64.dll'), path.join(appDir, 'steam_api64.dll'));
fs.writeFileSync(path.join(appDir, 'steam_appid.txt'), '480\n');
fs.copyFileSync(path.join(root, 'docs', '使用说明.txt'), path.join(appDir, '使用说明.txt'));
fs.copyFileSync(path.join(root, 'target', 'x86_64-unknown-linux-musl', 'release', 'cofisher-relay'), path.join(relayDir, 'cofisher-relay'));
fs.copyFileSync(path.join(root, 'target', 'release', 'cofisher-relay.exe'), path.join(relayDir, 'cofisher-relay.exe'));
for (const f of ['install-relay.sh', 'cofisher-relay.service']) {
  // Shell scripts must have LF line endings on Linux.
  fs.writeFileSync(path.join(relayDir, f), fs.readFileSync(path.join(root, 'deploy', f), 'utf8').replace(/\r\n/g, '\n'));
}

const zip = (src, out) => run('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Force -Path '${src}' -DestinationPath '${out}'`]);
zip(appDir, path.join(dist, 'CoFisher.zip'));
zip(relayDir, path.join(dist, 'cofisher-relay.zip'));

console.log(`
CoFisher.exe          ${mb(path.join(appDir, 'CoFisher.exe'))}
CoFisher.zip          ${mb(path.join(dist, 'CoFisher.zip'))}
cofisher-relay (linux) ${mb(path.join(relayDir, 'cofisher-relay'))}
cofisher-relay.exe    ${mb(path.join(relayDir, 'cofisher-relay.exe'))}`);
// The in-app updater looks for an asset named exactly CoFisher.exe on the latest GitHub release.
console.log(`
发布更新：在 GitHub 新建 Release，tag 填 v${require('../package.json').version}，上传 dist/CoFisher/CoFisher.exe（文件名不要改）`);
