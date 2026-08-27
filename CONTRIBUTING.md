# 贡献指南

欢迎通过 Issue 和 Pull Request 参与改进。

## Issue 提交规范

- 标题简明描述问题或需求。
- 描述复现步骤、期望行为与实际行为。
- 附上相关日志（请先脱敏，删除 Cookie、用户名、媒体链接等敏感信息）。
- 说明运行环境：Windows 版本、Chrome 版本、release 还是源码运行。

## Pull Request 流程

1. Fork 本仓库并创建功能分支。
2. 提交信息使用清晰的中文或英文描述，例如 `fix: correct archive mapping`。
3. 确保不提交 `config.json`、Cookie、日志、下载产物等本地敏感文件。
4. 提交前检查 `git status`，确认只包含预期变更。
5. 在 PR 描述中说明改动内容、测试方式和影响范围。

## 代码约定

- 保持现有文件结构与命名习惯。
- 新增命令行脚本时同步补充 `README.md`。
- 涉及路径的改动需同时更新 `config.example.json`。
