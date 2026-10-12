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

工作流仅上传 `website/`，使用 `github-pages` 环境；源码、数据库、作品、API 密钥和完整文档目录不作为网站产物上传。并发部署按顺序完成，避免取消正在发布的版本。

发布成功后，检查官网及页面中的安装包链接。浏览器可能短暂缓存旧页面，可刷新后核对。

## 更新内容

- 修改 `website/index.html` 中的中英文文案时，同时核对两种语言的内容；截图说明与语言切换逻辑在 `website/app.js` 中。`?lang=en` 可直接打开英文版，语言选择仅保存在访问者浏览器。
- 截图和图标放在 `website/assets/`，不要加入个人作品截图或配置文件。
- 发布新版安装包后，更新页面中的版本号、平台要求、下载地址与签名状态；下载链接指向已有的 GitHub Release 文件。
- 官网页面部署与桌面安装包构建相互独立。更新官网不会替换已经发布的安装包。

GitHub Pages 工作流参考 [GitHub 官方部署说明](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。
