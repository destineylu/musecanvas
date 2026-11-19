# 公司内部 NAS 部署：每人独立工作区

本方案采用每人独立的 musecanvas 一体化容器（内置 Muse 浏览器引擎），不是一个共享实例中的多个登录用户。每个人使用自己的入口、登录账号、Muse Cookie、账号池、浏览器 profile、模型密钥、数据库及文件目录。不能把多个人配置在同一个账号池，也不能复制别人的数据卷。旧的独立 muse2api 容器不再需要。

## 生成与启动

本目录保留公司内部 NAS 运维方案。GitHub Releases 面向普通用户发布 Windows 便携包，不再发布 NAS 镜像或 Linux 一键安装包。已有公司实例继续使用，新增工作区由管理员从源码构建。

从源码安装时，NAS 安装 Docker Compose 和 Node.js 18+（Node 仅用于生成部署文件；应用镜像内为 Node 24）。在源码根目录执行，例如：

```sh
node deploy/nas/create-instance.mjs --name alice --email alice@example.com --port 8788 --url https://alice.canvas.example.com
node deploy/nas/create-instance.mjs --name bob --email bob@example.com --port 8789 --url https://bob.canvas.example.com
```

为两个用户分别生成 `deploy/nas/instances/alice` 和 `bob`。进入每个目录执行：

```sh
docker compose up -d --build
```

每个目录的 `.env` 包含随机生成的初始登录密码、JWT 签名密钥和内置引擎密钥；通过 NAS 文件管理器私下查看并分别交给对应用户，不要复制给其它人。不要把包含凭据的目录提交到 Git。生成器拒绝覆盖已有目录。

默认端口仅监听 NAS 的 127.0.0.1，反向代理分别将两个域名转发到 NAS 的 8788、8789；应保留原始 Host，并完整转发 Cookie、Range、SSE，关闭响应缓冲，读取超时至少 1900 秒。如果反代自身在容器中，127.0.0.1 指向反代容器，应改为 NAS 内网 IP（生成时加 `--bind 192.168.1.10`），并限制这些端口仅内网可达。不同用户优先使用不同子域名，不要用同一域名的路径前缀区分。

仅内网 HTTP 访问时可不填 `--url`，并用 `--bind NAS内网IP` 指定绑定地址；此时 COOKIE_SECURE=0。HTTPS 入口设 COOKIE_SECURE=1。`PUBLIC_BASE` 应与实际访问域名一致。不要把 HTTP Cookie 模式直接用于公网。

## 用户如何使用

1. 打开分配给自己的工作区地址，用对应邮箱与初始密码登录。本模式禁用免登录和注册，不接受其它人的账号。管理员在 NAS 上为新成员生成新的容器组。
2. 进入「设置 → 接入方式 → muse2api → 打开账号池」，粘贴自己登录 Muse 后的 Cookie 或通过绑定扩展导入。NAS 可在扩展弹窗手填个人工作区地址和绑定码，首次使用由浏览器询问该地址的连接权限。NAS 不会继承你电脑上的浏览器登录态。
3. 外部模型、API Bridge 分别填写本人可使用的密钥；不要导入他人的账号或共享一个付费账号池。每个工作区独立保存设置。
4. 素材、历史、画布、对外 API Key 也都留在此工作区。未登录不能读取媒体；退出登录会清除媒体访问会话。
5. 工作区密码与 Muse 登录凭据是两回事。由 NAS 管理员分配初始工作区密码，登录后可在「设置 → 账号」修改；Muse Cookie 到期后在自己的工作区重新绑定。

## 隔离边界与资源

- Compose 项目名与网络随用户名区分；每人只有一个 musecanvas 容器。内置浏览器引擎仅监听容器自己的 127.0.0.1:18610，调试端口也不发布到 NAS。
- 应用数据位于 data/server，内置引擎数据与 profiles 位于 data/engine，均为本目录下独立卷。NAS 文件管理员 / root 仍可读取这些数据，应用隔离不防护 NAS 管理员。
- 默认每人 1 个生成任务，整个一体化容器最多 1536 MB、CPU 上限 0.75 核；这些是资源上限，实际能容纳多少用户要按 NAS CPU、内存和浏览器占用测量。Cookie 登录可能还受登录有效期、出口网络和 Muse 自身限制影响。
- 容器内 `127.0.0.1` 指向容器自己。连接运行在另一台电脑的 ComfyUI 时填其局域网 IP，不填电脑本机的 127.0.0.1。不要把一个未鉴权的 ComfyUI 管理接口直接开放给所有成员；本方案没有跨实例的 GPU 调度器，共享 GPU 需由 NAS 管理员单独限制队列并发。
- NAS CPU 架构需能运行 Node 24、Python 与 Chromium 镜像；ARM NAS 的 Chromium 和依赖必须实际构建验证。这里没有声称已在你的 NAS 上完成运行测试。
- 备份每个用户完整的 `data` 和 `.env`，恢复时只恢复到该用户的实例。禁止挂载现有桌面版多人旧数据库到隔离模式；启动会拒绝含其它邮箱的数据。

`deploy/docker` 与本目录生成器都使用一体化镜像；多个用户分别生成独立实例，不再部署外置 muse2api 容器。


## 登录与更新后排查

- 使用对应用户的独立入口。工作区邮箱 / 密码、Muse Cookie 和供应商 API Key 分别配置，不能互相替代。
- 登录失败先核对工作区与账号是否匹配、PUBLIC_BASE 是否与访问域名一致，以及 HTTPS / COOKIE_SECURE 设置；会话过期需重新登录。
- 更新时先等现有任务完成，在该用户部署目录执行 `docker compose up -d --build`，服务就绪后刷新页面。只更新自己的容器组，不共用或覆盖他人的数据卷。
- 桌面版的「重新连接」处理免登录会话；NAS 账号模式仍必须登录，不能使用本机接口绕过。
- 完整创作操作与错误排查见 [使用说明](../../docs/使用说明.md)。不要删除数据库、密钥或 profiles 作为排查第一步。
# NAS 的 Muse 出站代理

Windows 的代理配置不会自动作用于 NAS。可在 NAS 的独立 Docker 网络运行 Mihomo，再让工作区加入该网络；只需代理出站，不需要启用 TUN 或公开代理端口。

在工作区 Compose 的 `environment` 中设置：

```yaml
MUSE2API_BROWSER_PROXY: http://musecanvas-proxy:7890
HTTP_PROXY: http://musecanvas-proxy:7890
HTTPS_PROXY: http://musecanvas-proxy:7890
NO_PROXY: localhost,127.0.0.1,::1,.ts.net,100.64.0.0/10,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
```

`musecanvas-proxy` 是同一 Docker 网络中的代理服务名。`MUSE2API_BROWSER_PROXY` 是 Chromium 启动时的默认代理；已配置的账号独立代理仍优先。修改后重建工作区容器使浏览器重启。不要将 Windows 路径或 `127.0.0.1:7890` 直接照搬到 NAS 的另一个容器。

配置文件内的节点密码、订阅地址和控制器 secret 应仅保存在 NAS 私有目录，不得提交仓库。控制器与代理端口无需开放到公网。网络可达、Cookie 登录有效、云端工作区可用和真实生成成功是不同检查项，不能互相替代。
