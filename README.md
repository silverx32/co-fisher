# 摸鱼搭子 Co-Fisher

可以和朋友联机的桌面宠物：小人蹲在屏幕右下角，你一敲键盘它就跟着打字；敲击次数攒成点数，换成 🍅 番茄 / 🦑 墨鱼汁 / 💩 屎，点好友小人下面的道具按钮，糊 TA 一脸。

- 单个 exe（约 10MB 以内），用 Windows 10/11 自带的 WebView2 显示界面
- 6 个 Q 版角色（Claude、Codex、豆包、Gemini、DeepSeek、Kimi），每个 1 张待机 + 3 张打字图：每敲一下键盘随机闪一张打字图，随即回到待机；也可以上传自定义形象
- 每个房间最多 8 人；联机方式：**Steam P2P 联机（测试 AppID 480 Spacewar，免公网/免服务器）** / 局域网房主 / 云端中转服务器 / IPv6 直连

玩家使用说明见 [docs/使用说明.txt](docs/使用说明.txt)（会随 exe 一起打包）。

## 部署中转服务器（跨网联机）

### Docker（宝塔）

先运行 `npm run release` 生成 Linux 服务端，再将 `deploy/docker/` 中的文件和
`dist/relay/cofisher-relay` 放到服务器同一目录。复制 `.env.example` 为 `.env`，
填写独立的 `RELAY_PASSWORD` 后执行 `docker compose up -d --build`。
放行 TCP **15880**，客户端填写 `服务器公网IP:15880`。容器内部端口仍为 23333。
详细步骤见 [部署说明](deploy/docker/部署说明.txt)。

### 直接安装为系统服务

### Docker（宝塔）

先运行 `npm run release` 生成 Linux 服务端，再将 `deploy/docker/` 中的文件和
`dist/relay/cofisher-relay` 放到服务器同一目录。复制 `.env.example` 为 `.env`，
填写独立的 `RELAY_PASSWORD` 后执行 `docker compose up -d --build`。
放行 TCP **15880**，客户端填写 `服务器公网IP:15880`。容器内部端口仍为 23333。
详细步骤见 [部署说明](deploy/docker/部署说明.txt)。

### 直接安装为系统服务

### Docker（宝塔）

先运行 `npm run release` 生成 Linux 服务端，再将 `deploy/docker/` 中的文件和
`dist/relay/cofisher-relay` 放到服务器同一目录。复制 `.env.example` 为 `.env`，
填写独立的 `RELAY_PASSWORD` 后执行 `docker compose up -d --build`。
放行 TCP **15880**，客户端填写 `服务器公网IP:15880`。容器内部端口仍为 23333。
详细步骤见 [部署说明](deploy/docker/部署说明.txt)。

### 直接安装为系统服务

系统选 **Ubuntu 22.04 或 24.04 LTS**（CentOS 已停止维护，不建议）。配置要求很低：1 核 1G 足够跑很多个房间，中转程序本身不到 1MB、占用几 MB 内存。

1. `npm run release` 后，把 `dist/cofisher-relay.zip` 上传到服务器并解压（或直接 `scp dist/relay/* root@服务器IP:/root/relay/`）
2. 安装为系统服务（开机自启、崩溃自动重启）：
   ```bash
   cd /root/relay
   sudo sh install-relay.sh 你的密码 23333     # 密码可以不填：sudo sh install-relay.sh
   ```
3. **在云服务器控制台的安全组 / 防火墙里放行 TCP 23333**（这一步最容易漏）
4. 朋友们在 App 里填 `服务器公网IP:23333` + 同一个房间号 + 密码

常用命令：`systemctl status cofisher-relay`、`journalctl -u cofisher-relay -f`、改密码编辑 `/etc/systemd/system/cofisher-relay.service` 后 `systemctl daemon-reload && systemctl restart cofisher-relay`。

用 IP + 端口直连不需要网站备案；只有绑定域名并走 80/443 提供网站服务时才涉及备案。

## 开发

需要 Rust（stable）和 Node.js（只用于测试和资源脚本）。

```bash
npm install                 # 测试用的 ws
npm run dev                 # 以开发模式运行 App
npm test                    # Rust 单元测试 + 协议测试（对着真实的中转程序跑）
npm run release             # 发布：dist/CoFisher/CoFisher.exe、dist/relay/*、两个 zip
rustup target add x86_64-unknown-linux-musl   # 第一次发布前：用于编译 Linux 版中转程序
```

角色资源：图集放在 `art/atlas/{idle,typing1,typing2,typing3}.png`（3×2 网格），`npm run slice` 切成 `ui/assets/characters/<id>/*.png`；`npm run icon` 重新生成程序图标。新增/调整角色时同步修改 `server/src/lib.rs` 的 `CHARACTERS` 和 `app/src/main.rs` 的 `CHARACTER_INFO`。

目录：

| 路径 | 内容 |
| --- | --- |
| `server/` | 房间服务器库（App 内当房主和独立中转共用）+ `cofisher-relay` 程序 |
| `app/` | Tauri 应用：窗口、托盘、键盘计数、钱包存档、联机客户端 |
| `ui/` | 宠物窗口与糊脸覆盖层页面 |
| `test/` | 协议测试 |
| `tools/` | 切图、图标、发布脚本 |
| `deploy/` | 中转服务器的 systemd 服务与安装脚本 |

隐私：键盘钩子只统计按下次数，不记录也不发送按了哪个键。网络上只传昵称、角色、点数、是否在打字、道具数量和自定义形象图片。
