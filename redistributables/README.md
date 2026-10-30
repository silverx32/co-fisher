# 离线运行时

制作离线发布包时，将微软官方 WebView2 x64 Evergreen Standalone Installer
保存为本目录中的 `MicrosoftEdgeWebView2RuntimeInstallerX64.exe`，然后运行
`node tools/package-offline.js`。需要先完成 `npm run release`。

安装程序体积较大，不纳入 Git；普通开发和中转服务器部署不需要此文件。
