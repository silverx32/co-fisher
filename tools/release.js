'use strict';
// Release build:
//   dist/CoFisher/CoFisher.exe            the app (single exe; uses the WebView2 built into Win10/11)
//   dist/relay/cofisher-relay             Linux relay (static, for a cloud server)
//   dist/relay/cofisher-relay.exe         Windows relay
//   dist/relay/install-relay.sh + .service
//   dist/docker/                          Docker (BaoTa) package: Dockerfile, compose.yaml, .env.example, relay
//   dist/CoFisher.zip, dist/cofisher-relay.zip, dist/cofisher-docker.zip
// Run: node tools/release.js   (DIST_DIR=dist/xyz to build somewhere else, e.g. while dist/CoFisher is running)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = process.env.DIST_DIR ? path.resolve(root, process.env.DIST_DIR) : path.join(root, 'dist');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
const mb = (f) => `${(fs.statSync(f).size / 1024 / 1024).toFixed(2)} MB`;

run('cargo', ['build', '--release', '-p', 'co-fisher', '-p', 'cofisher-server']);
run('cargo', ['build', '--release', '-p', 'cofisher-server', '--bin', 'cofisher-relay', '--target', 'x86_64-unknown-linux-musl']);

const appDir = path.join(dist, 'CoFisher');
const relayDir = path.join(dist, 'relay');
const dockerDir = path.join(dist, 'docker');
// Only our own outputs: dist/ may hold other things (e.g. an older copy that's running).
for (const p of [appDir, relayDir, dockerDir, ...['CoFisher.zip', 'cofisher-relay.zip', 'cofisher-docker.zip'].map((z) => path.join(dist, z))]) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
    console.error(`\n${path.relative(root, p)} 正在被占用：先退出从这里运行的 CoFisher.exe（托盘 → 退出）再发布。`);
    process.exit(1);
  }
}
for (const d of [appDir, relayDir, dockerDir]) fs.mkdirSync(d, { recursive: true });

// Text files for Linux get LF line endings.
const copyLf = (from, to) => fs.writeFileSync(to, fs.readFileSync(from, 'utf8').replace(/\r\n/g, '\n'));

fs.copyFileSync(path.join(root, 'target', 'release', 'CoFisher.exe'), path.join(appDir, 'CoFisher.exe'));
fs.copyFileSync(path.join(root, 'target', 'release', 'steam_api64.dll'), path.join(appDir, 'steam_api64.dll'));
fs.writeFileSync(path.join(appDir, 'steam_appid.txt'), '480\n');
fs.copyFileSync(path.join(root, 'docs', '使用说明.txt'), path.join(appDir, '使用说明.txt'));
fs.copyFileSync(path.join(root, 'target', 'x86_64-unknown-linux-musl', 'release', 'cofisher-relay'), path.join(relayDir, 'cofisher-relay'));
fs.copyFileSync(path.join(root, 'target', 'release', 'cofisher-relay.exe'), path.join(relayDir, 'cofisher-relay.exe'));
for (const f of ['install-relay.sh', 'cofisher-relay.service']) copyLf(path.join(root, 'deploy', f), path.join(relayDir, f));
// No .env in here: unzipping a newer package over the deployed folder keeps the password.
for (const f of ['Dockerfile', 'compose.yaml', '.env.example', '部署说明.txt']) copyLf(path.join(root, 'deploy', 'docker', f), path.join(dockerDir, f));
fs.copyFileSync(path.join(relayDir, 'cofisher-relay'), path.join(dockerDir, 'cofisher-relay'));

const zip = (src, out) => run('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Force -Path '${src}' -DestinationPath '${out}'`]);
zip(appDir, path.join(dist, 'CoFisher.zip'));
zip(relayDir, path.join(dist, 'cofisher-relay.zip'));
zip(path.join(dockerDir, '*'), path.join(dist, 'cofisher-docker.zip')); // files at the top level: unzip in place

console.log(`
CoFisher.exe          ${mb(path.join(appDir, 'CoFisher.exe'))}
CoFisher.zip          ${mb(path.join(dist, 'CoFisher.zip'))}
cofisher-relay (linux) ${mb(path.join(relayDir, 'cofisher-relay'))}
cofisher-relay.exe    ${mb(path.join(relayDir, 'cofisher-relay.exe'))}
cofisher-docker.zip   ${mb(path.join(dist, 'cofisher-docker.zip'))}`);
// The in-app updater looks for an asset named exactly CoFisher.exe on the latest GitHub release.
console.log(`
发布更新：在 GitHub 新建 Release，tag 填 v${require('../package.json').version}，上传 ${path.relative(root, path.join(appDir, 'CoFisher.exe'))}（文件名不要改）`);
