# 官网维护

官网地址：<https://asoming.github.io/writer-desk/>。

官网由 `website/` 中的 HTML、CSS、JavaScript 和图片组成，通过当前仓库的 GitHub Pages 发布，无需安装 npm 依赖或运行写作服务。它用于介绍产品、展示界面和提供安装包下载；不会连接本机小说库或保存用户作品。

## 本地预览

在仓库根目录运行：

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory website
```

访问 <http://127.0.0.1:8000/>，检查中英文切换、窄屏布局、截图与下载链接。官网资源使用相对路径，以兼容 GitHub Pages 的 `/writer-desk/` 项目路径。

## 发布

仓库的 **Settings → Pages → Build and deployment → Source** 应选择 **GitHub Actions**。首次发布需启用此设置。

将 `website/` 或 `.github/workflows/pages.yml` 的修改推送到 `main` 后，[Website 工作流](https://github.com/asoming/writer-desk/actions/workflows/pages.yml)自动部署。也可在该工作流页面选择 **Run workflow → main** 手动发布。其他分支不会部署。

工作流另设每小时一次的定时部署，用于更新 Star 数量快照；GitHub 调度可能延迟，不能保证准点刷新。每次上传前，工作流使用 GitHub 提供的临时凭据读取公开仓库的数量，并验证仓库名称、数量与更新时间，生成 `website/github-stars.json`。该文件只包含公开仓库名称、非负整数数量和毫秒时间戳；凭据只在构建环境中使用，不会进入页面或网站产物。

工作流仅上传 `website/`，使用 `github-pages` 环境；源码、数据库、作品、API 密钥和完整文档目录不作为网站产物上传。并发部署按顺序完成，避免取消正在发布的版本。

发布成功后，检查官网及页面中的安装包链接。浏览器可能短暂缓存旧页面，可刷新后核对。

## 更新内容

- 修改 `website/index.html` 中的中英文文案时，同时核对两种语言的内容；截图说明与语言切换逻辑在 `website/app.js` 中。`?lang=en` 可直接打开英文版，语言选择仅保存在访问者浏览器。
- 截图和图标放在 `website/assets/`，不要加入个人作品截图或配置文件。
- 发布新版安装包后，更新页面中的版本号、平台要求、下载地址与签名状态；下载链接指向已有的 GitHub Release 文件。
- 官网页面部署与桌面安装包构建相互独立。更新官网不会替换已经发布的安装包。
- Star 数量优先从公开 GitHub 仓库 API 自动读取，浏览器无需 Token。页面可见时每 5 分钟刷新，重新聚焦或显示页面时也会检查是否到期；API 断网或限流时尝试同源 `github-stars.json` 快照，并保留最近的有效结果。快照随每次部署更新，也由每小时工作流定时更新；其数量可能比 GitHub 当前值稍旧。所有来源均不可用时显示 `—`，不会将未知数量显示为 0。中英文和两个 Star 入口共用同一计数。

GitHub Pages 工作流参考 [GitHub 官方部署说明](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。
