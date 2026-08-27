# Third-Party Notices

本项目感谢以下开源项目的支持。发行版中直接打包或间接依赖的组件及其许可证如下。

| Component | Version | License | Bundled | Full license |
| --------- | ------- | ------- | ------- | ------------ |
| Node.js | 24.19.0 | MIT（含第三方组件声明） | Yes | [nodejs-LICENSE](THIRD_PARTY_LICENSES/nodejs-LICENSE) |
| Playwright | 1.62.1 | Apache-2.0 | Yes | [playwright-LICENSE](THIRD_PARTY_LICENSES/playwright-LICENSE) |
| yt-dlp | 2026.08.19 | Unlicense | Yes | [yt-dlp-LICENSE](THIRD_PARTY_LICENSES/yt-dlp-LICENSE) |
| FFmpeg | 7.1 (gyan.dev essentials build) | GPL-3.0-or-later | Yes | [ffmpeg-GPL-3.0.txt](THIRD_PARTY_LICENSES/ffmpeg-GPL-3.0.txt) |

## FFmpeg / GPL notice

发行版中的 `ffmpeg.exe` 来自 [gyan.dev](https://www.gyan.dev/ffmpeg/builds/)，构建参数包含
`--enable-gpl --enable-version3`，并链接了 `libx264`、`libx265`、`libxvid` 等 GPL 组件，因此该二进制按
GPL-3.0-or-later 发布。

如果你分发本项目发行包，必须同时分发本文件与
[ffmpeg-GPL-3.0.txt](THIRD_PARTY_LICENSES/ffmpeg-GPL-3.0.txt)，并提供 FFmpeg 对应源码的获取方式：

- FFmpeg 官方源码：https://ffmpeg.org/download.html
- gyan.dev 构建源码：https://www.gyan.dev/ffmpeg/builds/

本项目只使用 FFmpeg 的可执行文件，不对其源码进行修改。

## Non-bundled dependencies

以下组件未随发行版分发，仅在使用环境或开发环境中依赖：

- Python、pip、`imageio-ffmpeg`：仅开发环境或旧版下载路径使用，未打包进 release。
- `curl.exe`：Windows 10/11 系统自带组件，未随本项目分发。
- Chrome / Chromium：使用本机已安装的 Chrome，未随本项目分发。
- PowerShell、Windows Script Host：Windows 系统组件。

## Acknowledgements

- [yt-dlp](https://github.com/yt-dlp/yt-dlp)：视频元数据解析与下载核心。
- [Playwright](https://playwright.dev/)：浏览器自动化采集。
- [FFmpeg](https://ffmpeg.org/)：视频流合并与格式转换。
- [Node.js](https://nodejs.org/)：GUI 服务与脚本运行时。
