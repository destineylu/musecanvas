musecanvas v1.0：图片与视频创作画布，支持 Muse 双接入、外部模型、本地 ComfyUI、AI 搭建、分镜、一键依赖生成、素材库、历史回退与 3D 导演台。

此安装包适用于已有 Docker 和 Compose 的 Linux / NAS。每位用户一个独立 musecanvas 容器，内置自己的 Muse 浏览器引擎，无需部署独立 muse2api 容器。Cookie、账号池、模型密钥和数据独立保存。

一键安装（运行时询问登录邮箱，默认只绑定本机）：

```sh
curl -fsSL https://github.com/destineylu/musecanvas/releases/latest/download/install.sh | bash
```

局域网访问可下载脚本后执行：

```sh
bash install.sh --name owner --email you@example.com --bind 192.168.1.10 --port 8787
```

将 IP 换成自己的 NAS 地址。安装目录默认为 `~/musecanvas`，初始密码保存在个人工作区 `.env` 的 `ADMIN_PASSWORD`。HTTPS 反代使用 `--url https://你的域名`。每个成员需要使用不同 `--name`、`--port` 和安装目录，不共用数据卷。

下载 `musecanvas-install.tar.gz` 是完整源码安装包，`install.sh` 是安装入口，`musecanvas-image-amd64.tar.gz` 为预构建镜像，`SHA256SUMS` 用于校验；浏览器绑定扩展单独提供。x86_64 / amd64 默认下载并校验已构建的镜像，再直接加载运行，无需本机 Node 或另装 muse2api。ARM64 或加 --build 时从源码构建，需联网下载依赖。

程序安装包免费下载；Muse、外部模型供应商的账号、额度及费用按对应服务执行。本包不包含任何个人账号、Cookie 或密钥。
