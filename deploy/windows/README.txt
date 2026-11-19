musecanvas v1.0 · Windows 一键启动版

使用方法：
1. 将整个 ZIP 解压到可写目录，例如 D:\musecanvas。
2. 双击 start.cmd，程序自动打开本机工作区，无需注册。
3. 进入「设置」，绑定自己的 Muse 账号，或配置 API Bridge / 其它模型。
4. 双击 stop.cmd 停止程序，已有项目和素材保留。

运行要求：Windows 10/11 64 位，已安装 Microsoft Edge 或 Google Chrome。
包内自带 Node.js、Python 和应用依赖，无需 Docker、Git 或手动安装开发环境。
远端生成需要联网，并使用用户自己的账号和额度。本包不包含任何个人账号、
Cookie、API Key、代理订阅、公司域名或 NAS 配置。
仅当所用 API Bridge 位于 Tailscale 私有网络时，才需要连接对应的 Tailscale 网络。

更新前备份 server/data、upstream/muse2api/data、upstream/muse2api/profiles
以及 server/.env、upstream/muse2api/.env。先解压新版到单独目录，再迁移备份；
不要直接覆盖正在运行的目录，不要分享自己的数据或 .env 文件。
详细操作见 docs/使用说明.md。

musecanvas v1.0 - Windows x64

1. Extract the entire ZIP to a writable folder (for example D:\musecanvas).
2. Double-click start.cmd. The local workspace opens in your browser.
3. Open Settings to bind your own Muse account or configure API Bridge / other models.
4. Double-click stop.cmd to stop musecanvas. Your projects and media are preserved.

Node.js and Python are bundled. Docker, Git and manual dependency installation are not required.
Windows 10/11 x64 and Microsoft Edge or Google Chrome are required.
No registration is required for the local workspace.
First launch creates unique local credentials. No accounts, Cookies, keys, proxy subscriptions,
company domains or NAS settings are included in this package.
Muse, API providers and remote models need network access and your own accounts/quotas.
Tailscale is only required when your chosen API Bridge endpoint is inside a tailnet.

Keep server/data, upstream/muse2api/data and both .env files when upgrading.
Extract a new version into a separate folder before moving your backed-up data/configuration.
Do not overwrite or share another person's data or .env files.
See docs/使用说明.md for detailed instructions.
