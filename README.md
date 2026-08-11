# CohortHarbor

可自托管的员工入职、制度学习与考试平台。CohortHarbor 把员工账号、入职资料、制度版本、在线学习、考试任务、通知邮件和私有文件保护放在一个全栈应用中，适合内部部署、二次开发和开源协作。

[![CI](https://github.com/ailsazhang94-jpg/cohort-harbor/actions/workflows/ci.yml/badge.svg)](https://github.com/ailsazhang94-jpg/cohort-harbor/actions/workflows/ci.yml)
[![CodeQL](https://github.com/ailsazhang94-jpg/cohort-harbor/actions/workflows/codeql.yml/badge.svg)](https://github.com/ailsazhang94-jpg/cohort-harbor/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-0f766e.svg)](LICENSE)

> 当前仓库提供的是可公开使用的通用代码与 mock 数据。仓库不包含真实员工、生产数据库、企业制度原件或 SMTP/API 密钥；部署时请通过环境变量和私有存储注入组织自己的数据。

## 项目介绍

平台面向企业 HR、行政、IT 和新员工，支持从员工账号建立、入职资料发布、制度阅读到考试与通知的完整闭环。管理员可以管理组织内容和员工，员工只能访问当前账号有权限且已发布的内容。

## 核心能力

- 员工入职流程管理与员工名册导入
- 企业制度中心与版本化文档预览
- 在线学习、资料包发布与 ZIP 下载
- 在线考试、题库、考试任务、补考和结果管理
- 自动化欢迎邮件、模板、附件、抄送和投递记录
- 四地欢迎门户与可视化内容编辑
- `SUPER_ADMIN`、`ADMIN`、`EMPLOYEE` 多角色权限管理
- 私有文件存储、服务端授权、水印和审计日志

## Features

- Multi-role permission system
- Secure document preview
- Exam management
- Email automation
- Visual onboarding portal and local OCR/import workflows

“AI knowledge assistant”目前是清晰的扩展方向：当前运行时没有接入 OpenAI 或其他 LLM，也没有虚构一个已上线的 Agent。现有代码提供制度/文档内容、权限边界、预览和业务流程基础，后续可在此基础上接入检索增强问答。详见 [docs/ai-agent.md](docs/ai-agent.md)。

## Tech Stack

- Next.js 16 App Router、React 19、TypeScript
- Prisma 7 + SQLite（通过 `better-sqlite3` adapter）
- Tailwind CSS 4、Tiptap、React Konva
- Nodemailer（可选 SMTP）、PDF.js、Tesseract.js、本地 Office/PDF 处理工具
- `xlsx`、`archiver`、`sanitize-html`、`yauzl` 等文件与内容处理库
- Vitest、Testing Library、Playwright、ESLint、TypeScript
- Node.js `24.14.0`；pnpm `11.16.0`

## Quick Start

```bash
corepack enable
corepack prepare pnpm@11.16.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env
# 编辑 .env，至少填写 ADMIN_USERNAME 和满足策略的 ADMIN_PASSWORD
pnpm db:ensure
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev
```

打开 <http://localhost:3000>。生产构建使用：

```bash
pnpm build
pnpm start
```

完整环境变量说明、SQLite 初始化、邮件配置和私有存储注意事项见 [docs/deployment.md](docs/deployment.md)。`.env`、数据库、上传目录和常见 Office/PDF 文件均已加入 `.gitignore`，不要将组织数据复制到 Git 工作树。

## Architecture

```text
Browser
  ├─ Employee UI ─┐
  └─ Admin UI ────┼─ Next.js App Router pages + API routes
                  ├─ session/RBAC guards
                  ├─ feature services
                  ├─ Prisma 7 / SQLite
                  └─ private storage + optional SMTP / local document tools
```

`src/app` 负责页面和 API 路由，`src/features` 按认证、员工、制度、资料包、考试、邮件、门户和审计等领域组织业务服务，`prisma` 保存 schema 与迁移，`storage/private` 保存不应公开的运行时资产，`tests` 与 `e2e` 提供自动化验证。数据流和边界见 [docs/architecture.md](docs/architecture.md)。

## Security Design

- **RBAC**：保留 `SUPER_ADMIN`、`ADMIN`、`EMPLOYEE` 角色体系。服务端 guard 对管理端、超级管理员专属操作、员工端 API 和文件下载分别授权，前端隐藏不是唯一安全边界。
- **Private storage**：制度原件、预览文件、入职资料、邮件附件和门户素材默认写入 `storage/private/`，通过数据库资产记录和服务端路径校验访问，不直接放入 `public/`。
- **Watermark**：制度、指南和考试相关视图可显示当前会话姓名水印；水印用于追踪和降低误传播风险，不能替代访问控制，也不能阻止截图。
- **Account/session protection**：密码使用带随机盐的哈希；会话、密码修改/重置、管理员操作和关键业务行为受到服务端校验与审计约束。
- **Data isolation**：发布状态、城市/适用范围、员工模块开关和角色共同限制可见内容；mock seed 只使用示例组织、示例员工和通用考试题目。

更多边界和部署建议见 [docs/security.md](docs/security.md)。

## Public Release Integrity

公开仓库使用独立的干净 Git 历史，不包含私有源仓库的分支、标签、评审记录或本机运行产物。示例邮箱使用 `.invalid` 保留域名；固定测试口令只服务于自动化测试，不是部署默认值。发布时同时提供 [NOTICE](NOTICE)、[第三方归属清单](THIRD_PARTY_NOTICES.md)、[REUSE SPDX 声明](REUSE.toml) 和 [SPDX SBOM](sbom.spdx.json)。

## Roadmap

- AI Agent enhancement：在权限感知检索、引用溯源和人工确认基础上增强制度问答
- Enterprise workflow automation：扩展入职任务编排、审批和外部系统适配器
- Knowledge base integration：接入可配置的企业知识库、向量索引和文档同步
- 可插拔组织/身份源与生产级数据库部署方案

## Documentation

- [架构说明](docs/architecture.md)
- [部署指南](docs/deployment.md)
- [安全设计](docs/security.md)
- [AI Agent 能力边界](docs/ai-agent.md)
- [贡献指南](docs/contribution.md)
- [安全漏洞报告流程](SECURITY.md)
- [第三方归属清单](THIRD_PARTY_NOTICES.md)

## Contributing

欢迎提交 Issue、改进文档、修复 bug 或贡献功能。请先阅读 [贡献指南](docs/contribution.md) 和 [行为准则](CODE_OF_CONDUCT.md)，并在提交 Pull Request 前运行 lint、typecheck、build 和相关测试。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## License

项目原创代码与 SVG 品牌资源使用 [MIT License](LICENSE)。依赖和 vendored 资产保留各自许可证，详见 [NOTICE](NOTICE)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 `LICENSES/`。MIT 许可证不授予第三方商标权，也不覆盖部署者自行导入的组织数据或内容。
