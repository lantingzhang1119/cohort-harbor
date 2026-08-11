# 四城可视化门户编辑器

本文档描述当前代码中已经实现的四城可视化门户能力，供开发与运维对照。行为以代码、迁移和自动化测试为准；V1 数据迁移详见 `docs/migrations/2026-07-25-portal-scene-v1.md`。

---

## 1. 架构与 Konva 选型

### 1.1 分层

| 层 | 路径 | 职责 |
|----|------|------|
| 沉浸式编辑器 UI | `src/features/portal/editor/visual-editor.tsx` 及同目录组件 | 城市/设备切换、草稿加载保存、预览、复制桌面→手机、发布、历史/恢复、素材与属性面板 |
| 交互画布 | `src/features/portal/editor/editor-stage.tsx`、`element-node.tsx` | **react-konva** `Stage` / `Layer` / 形状与 `Transformer`；设计平面 a11y 层；背景 CSS 平面 |
| 场景模型 | `src/features/portal/portal-scene.ts`、`portal-geometry.ts` | Portal Scene V1 schema、画布尺寸、几何/吸附/归一化 |
| 领域服务 | `src/features/portal/portal-service.ts` | 草稿 CRUD、复制、发布、历史、恢复、素材校验与引用 |
| 员工/预览渲染 | `src/features/portal/components/published-scene.tsx` | **DOM/CSS** 发布场景（非 Konva） |
| 兼容 v0 渲染 | `src/features/portal/components/portal-viewer.tsx` | 旧版仅 Logo/图片元素的比例定位展示 |

### 1.2 为何编辑器用 Konva

- 需要像素级**拖动、八个缩放锚点与一个旋转锚点**（`Transformer`，见 `element-node.tsx`）。
- 需要图层选择、吸附参考线、图片裁剪会话（`image-crop.ts` + 裁剪层交互）。
- 员工端与管理员预览走 `PublishedScene` 的 CSS `transform: scale(...)` 与背景 `background-size: contain|cover`，与编辑器背景平面对齐，避免把完整 Konva 运行时下发到员工端。

### 1.3 编辑器画布结构（实现细节）

宿主 `portal-editor-stage-host`（`overflow: visible`）包含：

1. **裁剪盒** `portal-editor-canvas-clip`（`overflow: hidden`）：CSS 背景平面 + Konva Stage。
2. **背景平面** `portal-editor-background-plane`：设计尺寸上的 `background-size` / `background-position`，再 `scale(zoom)`。
3. **Konva 层**：透明命中板（background layer）→ **elements layer** → guides layer。
4. **a11y 设计平面** `portal-design-plane`：透明几何热区 / 选中框标记（`pointer-events: none` 于元素按钮上，画布命中仍进 Konva）。
5. **精确调整条** `portal-adjustment-overlay`：固定 CSS 尺寸的 6 按钮条，**位于 clip 外**，极端缩小（如 10%）时不被画布 `overflow:hidden` 裁掉。

验证几何时，E2E 通过 **elements 层 canvas 的 `toDataURL`** 取真实绘制像素，而非对第一层透明 canvas 做页面合成截图（见 `e2e/portal-editor.spec.ts`）。

---

## 2. 四城与桌面/手机隔离

### 2.1 城市与视口

- 城市枚举：`SHANGHAI` | `SHENZHEN` | `CHANGSHA` | `XIAN`（与 Prisma `City` 一致）。
- 视口：`DESKTOP` | `MOBILE`。
- 画布尺寸（`PORTAL_CANVAS_SIZES` / `portal-scene.ts`）：
  - 桌面：**1440 × 900**
  - 手机：**390 × 844**

### 2.2 数据隔离键

| 实体 | 唯一/索引 | 含义 |
|------|-----------|------|
| `GuidePortalDraft` | `@@unique([city, viewport])` | 每城每设备一份草稿 |
| `GuidePortalPublication` | `@@unique([city, viewport, version])` | 每城每设备每版本一条发布；同一次发布桌面/手机共用 **version** |

草稿保存、复制、发布均按 `city` 过滤；跨城不共享草稿行。编辑器状态机在 `loadContext` 时递增 `generation` 并清空历史面板，避免串城请求污染（`visual-editor.tsx`）。

### 2.3 入口

- 概览：`/admin/guides` → 四城卡片链到编辑器（`src/app/(admin)/admin/guides/page.tsx`）。
- 编辑器：`/admin/guides/editor?city=…&viewport=DESKTOP|MOBILE`
  - 布局：`src/app/(portal-editor)/layout.tsx`（`requirePageUser("ADMIN_ACCESS")`）
  - 页面：`src/app/(portal-editor)/admin/guides/editor/page.tsx`

---

## 3. 角色与权限（UI / 服务端 / 数据）

### 3.1 写入方：超级管理员与管理员

- 页面能力：`ADMIN_ACCESS`（`server-session.ts` 的 `requirePageUser`）——超级管理员与管理员均可进入编辑器。
- 管理 API：`requireAdminRequest` → `requireAdmin(session)`（`src/features/employees/route-utils.ts`），挂在：
  - `GET/PATCH/POST /api/admin/portal/[city]/draft`
  - `POST /api/admin/portal/[city]/publish`
  - `GET /api/admin/portal/[city]/history`
  - `POST /api/admin/portal/[city]/restore`
  - `GET/POST/DELETE /api/admin/portal/[city]/assets`
- 变更写审计日志（如 `PORTAL_DRAFT_*`、`PORTAL_PUBLISH`、`PORTAL_PUBLICATION_RESTORE`），并带 `updatedBySnapshot` / `publishedBySnapshot`。
- CSRF：管理写接口 `assertSameOrigin`。

### 3.2 只读方：员工

- 页面：`/employee/guides`、`/employee/guides/[city]` 经 `requireEmployeeModulePage(EmployeeModuleKey.GUIDES)`。
- 公开门户 API：`GET /api/portal/[city]?viewport=…`
  - `requireEmployeeModuleRequest(…, GUIDES)`（`src/app/api/portal/[city]/route.ts`）
  - 仅返回 **`getPublishedPortal`** 最新发布；无草稿字段。
- 客户端：`GuideViewer`（`src/features/guides/components/guide-viewer.tsx`）拉发布数据；V1 用 `PublishedScene`，v0 用 `PortalViewer`。

### 3.3 私有素材访问

- 路由：`GET /api/files/[assetId]`（`src/app/api/files/[assetId]/route.ts`）。
- **员工** + `PORTAL_IMAGE`：仅当素材被**当前城市视口最新发布**的 `GuidePortalAssetReference` 引用，且对应 `CityGuide.enabled`。
- **管理员视图**：上传后的 `PORTAL_IMAGE` 可预览（注释写明允许草稿引用前预览）；其它 kind 默认拒绝。

### 3.4 员工端板块开关

系统设置中 `EmployeeModuleKey.GUIDES` 关闭时，员工导航/页面/API 对四城指南不可用（与全站模块机制一致，非门户专用后门）。

### 3.5 E2E 角色边界

`e2e/portal-editor.spec.ts`：`e2e-admin` / 普通管理员可进编辑器；员工 `E2E-SEC` 访问 `/admin/guides/editor` 被挡回员工域，且无「保存并发布」。

---

## 4. 素材与校验

| 项 | 实现位置 | 规则（摘要） |
|----|----------|--------------|
| 上传上限 | `portal-file-validation.ts` `MAX_PORTAL_IMAGE_BYTES` | **10 MiB** |
| 边长 / 像素 / 动图 | 同文件 `MAX_PORTAL_IMAGE_SIDE` 等 | 边长、静态像素、帧数与解码代价上限 |
| 格式 | 扩展名 + MIME + 魔数/结构检查 | PNG/JPEG/WebP/GIF 等受检格式 |
| 元数据 | `GuidePortalAssetMetadata` | category、宽高、帧、检查状态 |
| 引用 | `GuidePortalAssetReference` | 草稿或发布二选一归属；元素 id 关联 |
| 场景预算 | `assertSceneBitmapBudget`（service） | 发布前对 V1 场景位图成本再检 |

管理端素材 API：`/api/admin/portal/[city]/assets`。编辑器内上传背景 / Logo / 图片组件走资产面板（`asset-panel.tsx` 等）。

---

## 5. 背景 contain / cover

- 场景背景字段：`fitMode` `CONTAIN` | `COVER`，`positionX` / `positionY`（百分比），`backgroundColor`，`assetId`（`portal-scene.ts`）。
- **编辑器**：CSS 背景平面使用与发布端相同的 `background-size` / `background-position`（`editor-stage.tsx`），避免仅 Konva 重采样导致与员工端不一致。
- **发布端**：`PublishedScene` 在 `published-scene-plane` 上同样用 CSS 背景（`published-scene.tsx`）。
- 页面设置面板：`page-panel.tsx`（「完整显示」/「铺满显示」对应 contain/cover）。

---

## 6. 直接操控与无障碍

### 6.1 指针 / Transformer

- 画布命中 Konva 节点：`element-node.tsx` 拖动、`Transformer` 缩放锚点与旋转。
- 精确 1px 宽高/1° 旋转：裁剪盒外的 `portal-adjustment-overlay` 六按钮（宽−/宽+/高−/高+/↶/↷）。
- 图片裁剪：`image-crop.ts` + 裁剪工具条；裁剪中锁定部分工作流按钮。

### 6.2 键盘与 a11y

- 工作区焦点：`画布工作区` 方向键微移（Shift ×10）。
- 设计平面元素 `aria-label`、Enter/F2 编辑文本（`text-overlay.tsx`）。
- 工具栏：撤销/重做、删除、复制粘贴、吸附、缩放比例 `output`、适应窗口（`editor-toolbar.tsx`）。
- 图层面板：选择/锁定/隐藏/前后移（`layer-panel.tsx`）。
- 属性面板：几何与样式数值（`property-panel.tsx`）；不可替代 Transformer 的 E2E 验收路径（Task9 要求真实锚点操作）。

### 6.3 组件类型

Scene V1 支持：`TEXT`、`RECT`、`CIRCLE`、`ELLIPSE`、`ROUND_RECT`、`TRIANGLE`、`LINE`、`ARROW`、`IMAGE`、`ICON`、`BUTTON`、`MARKER`（最多 **200** 元素，`PORTAL_MAX_ELEMENTS`）。

---

## 7. 草稿、预览、发布、当前版、历史与恢复

### 7.1 草稿

- 存储：`GuidePortalDraft.scene`（V1 JSON）+ `sceneVersion`、`draftRevision`、可选 `legacyElements`。
- API：`GET/PATCH /api/admin/portal/[city]/draft?viewport=`；乐观并发依赖 `draftRevision`。
- 客户端：`visual-editor.tsx` 保存、脏检查、冲突面板；sessionStorage 恢复键 `editor-recovery.ts`（按 userId + city + viewport）。

### 7.2 复制桌面 → 手机

- `POST` draft body `action: COPY_DESKTOP_TO_MOBILE` + 双端 revision。
- 服务端将桌面场景约束到手机画布（`portal-service` 中 `mobileElement` 等缩放逻辑），手机稿标记需审查（`requiresMobileReview: true`）。

### 7.3 预览

- 编辑器内 `PublishedScene` 对话框，文案「预览（未发布）」；**不写发布表**。

### 7.4 原子双视口发布（V1）

- `POST /api/admin/portal/[city]/publish`，body 含 `revisions: { desktop, mobile }`。
- `publishPortalScenes`：同一事务内要求桌面+手机均为 `sceneVersion === 1`、revision 匹配、场景非空、**手机已确认审查**（`requiresMobileReview === false`），然后为两视口创建**相同 version** 的两条 `GuidePortalPublication`，写引用与审计。
- 旧体路径 `publishPortal` 仅服务 v0 草稿；V1 场景走 `publishPortalScenes`。

### 7.5 当前发布与历史

- 员工读取：每城每视口 **version 最大** 的一条。
- 历史列表：`listPortalHistory`（默认最多 10 个**成对**桌面+手机版本）。
- 历史 UI：请求序号 + `AbortController`；关闭（工具栏或对话框「关闭发布历史」）统一 `closeHistoryPanel`（`visual-editor.tsx`），防止同城重开串数据。

### 7.6 恢复

- `POST /api/admin/portal/[city]/restore`：`restorePortalPublication` 将指定 **version + viewport** 写回该视口草稿（revision 校验），不自动再发布。

---

## 8. V0 → V1 迁移、审计、备份与回滚边界

完整操作说明见 **`docs/migrations/2026-07-25-portal-scene-v1.md`**。摘要：

| 主题 | 行为 |
|------|------|
| 命令 | `pnpm portal:migrate -- --database … --private-root …`（`--dry-run` 只读） |
| 结构迁移 | Prisma：`202607250001_visual_portal_scene`、`202607250002_visual_portal_publication_scene` 等 |
| 成对转换 | 旧发布按 `(city, version)`；桌面+手机均可解析且素材齐全才转 V1，否则 **V0_FALLBACK** |
| 草稿 | 可按视口转换；保留 `legacyElements`，必要时增加 `draftRevision` |
| 备份/审计 | 有变更时写 `portal-scene-v1-*.backup.sqlite` 与 `*.json`（0600、安全命名）；dry-run 不写 |
| 回滚边界 | 事务失败回滚 DB；成功后需用备份文件人工恢复；不删私有素材；不发邮件 |
| 范围错误 | 库内出现四城外草稿/发布 → 非零退出 |

员工端对 `sceneVersion === 0` 仍用 `PortalViewer`；`=== 1` 用 `PublishedScene`。

---

## 9. 员工渲染

1. 员工打开 `/employee/guides/[city]` → `GuideViewer`。
2. 按视口请求 `GET /api/portal/{city}?viewport=DESKTOP|MOBILE`。
3. V1：`PublishedScene`（设计平面 + 元素 DOM/SVG/图片，缩放适配容器）。
4. 未发布：提示尚未发布；不暴露草稿。
5. 素材 URL：`/api/files/{assetId}`，仅最新发布引用可通过。

---

## 10. 验证命令与产物路径

### 10.1 常用命令

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e -- e2e/portal-editor.spec.ts   # Task9 门户专项
# 全量浏览器套件（更重）：
pnpm test:e2e
```

单元侧相关目录：

- `tests/ui/visual-editor-workflow.test.tsx` — 工作流/历史竞态/复制发布
- `tests/ui/editor-stage.test.tsx` — 舞台/背景 CSS/调整条宿主
- `tests/ui/editor-adjustment-group.test.ts` — 缩放网格与调整条几何
- `tests/visual/portal-pixel-diff.ts` + `*.test.ts` — 像素差、色 mask、描边端点
- `tests/visual/portal-geometry-parity.test.ts`
- `tests/portal/portal-service.test.ts` / `portal-service-v1.test.ts` — 含双 `PrismaClient` 并发发布版本分配
- `e2e/portal-editor.spec.ts` — 角色、编辑全路径、DESKTOP|MOBILE × DPR1|2 几何与高信息像素

### 10.2 编辑器 vs 发布：几何与高信息像素门（Task9 实测）

E2E 在 `DESKTOP|MOBILE × deviceScaleFactor 1|2` 四矩阵上分别验收。几何与像素差**独立**，不可互相放宽。

| 门 | 实现 | 阈值 / 参数 | 说明 |
|----|------|-------------|------|
| 几何（矩形边、箭头端点） | 编辑器 **elements 层** `toDataURL` 色 mask / 描边端点 vs 发布页 greenscreen DOM 色 mask | 双端换算后 **≤1 CSS px** | 不依赖 `channelTolerance`；与背景像素比无关 |
| 高信息背景像素比 | `rgbaPixelDiffRatio` 对比两端 only-CSS `CONTAIN` 裁剪（elements/Konva 隐藏） | 容差计算后的 **ratio &lt; 1%**（`PIXEL_DIFF_LIMIT = 0.01`） | 比例阈值固定；通道容差会影响哪些像素计为差异 |
| 通道容差 | `channelTolerance: 8`（`e2e/portal-editor.spec.ts`） | 仅吸收亚像素 CSS `background` 重采样 | 辅助 `portal-pixel-diff.ts` 文档默认/推荐为 **0**；实测 **tol=0 时 mobile scale=1 约 3%** 差，故 E2E 用 8 后仍要求 ratio &lt;1% |
| 非空白 / 高信息裁剪门 | `assertHighInformationCrop` → `measureImageContentStats` | `uniqueColors ≥ 24`、`stdDev ≥ 8`、`edgeEnergy ≥ 2` | 防止 letterbox/空裁冒充通过；与 ratio 门并列 |

要点：

1. **geometry masks 与 high-info map pixel diff 彼此独立**：形状端点用色 mask；地图 crop 在纯背景平面上比色。
2. **`channelTolerance = 8` 是有记录的 E2E 选择**，不是默认实现；不要把 helper 默认 0 误读成当前 E2E 参数。
3. **勿在无全量四矩阵 E2E 证明时收紧或放宽** `channelTolerance` 或 `PIXEL_DIFF_LIMIT`。

### 10.3 截图产物

目录：`artifacts/portal-editor/`

| 文件 | 含义 |
|------|------|
| `pc-editor.png` | 桌面编辑器 |
| `mobile-editor.png` | 手机编辑器 |
| `background-panel.png` | 页面/背景设置 |
| `component-panel.png` | 添加组件 |
| `selected-text.png` / `selected-shape.png` | 选中文本/形状 |
| `office-map.png` | 匿名合成地图背景（仅用于视觉回归） |
| `employee-pc.png` / `employee-mobile.png` | 员工端桌面/手机发布页 |

夹具：`tests/fixtures/office-map.png` 由 `scripts/generate-safe-office-map-fixture.mjs` 确定性生成，不包含真实办公室布局、员工姓名或业务数据；E2E/单测冻结 SHA256（见像素测试）。截图产物仅在本机生成并由 Git 忽略。

### 10.4 迁移验证（运维）

```bash
pnpm db:migrate
pnpm portal:migrate -- --database /abs/path/demo.db --private-root /abs/path/private --dry-run
pnpm portal:migrate -- --database /abs/path/demo.db --private-root /abs/path/private
```

---

## 11. 运维恢复与回滚

| 场景 | 建议 |
|------|------|
| 误发布 | 管理端历史恢复指定 version 到草稿 → 修正 → 再发布新 version；历史行不删除 |
| 坏草稿 | 用 session 恢复（若仍在）或从历史恢复；冲突时以服务端 revision 为准 |
| 迁移失败 | 使用同目录 `portal-scene-v1-*.backup.sqlite` 按迁移文档恢复；检查审计 JSON |
| 素材不可见（员工） | 确认已发布、引用存在、城市指南 `enabled`、GUIDES 模块开启 |
| 发布被拒 | 检查双端草稿齐全、revision、手机已审查、场景非空、位图预算 |

---

## 12. 首版已知限制

下列为**已实现范围内的边界**，非未写文档的虚构缺口：

1. **编辑器 Konva vs 发布 CSS**：几何 ≤1 CSS px 与高信息背景 **ratio &lt;1%** 分门验收（见 §10.2）；E2E 高信息 map 使用 **`channelTolerance = 8`**（helper 默认 0；tol=0 时 mobile scale=1 实测约 ~3% 重采样差）。几何色 mask 不依赖该容差。
2. **发布必须双视口 V1 草稿齐备**且手机审查通过；不能只发单端。
3. **历史列表最多 10 个成对版本**（service 上限）。
4. **元素上限 200**；图片单文件 10 MiB 及像素/动图限制。
5. **并发**：草稿写依赖 `draftRevision` 冲突（409），非 OT/CRDT；发布跨进程依赖 `unique(city,viewport,version)` + 可重试错误（P2002/锁），单进程内另有 per-client 串行队列；切换城/设备时未保存需确认。
6. **v0 与 V1 并存**：未成对升级的发布保持 fallback；混合完整性错误会让迁移失败。
7. **旧 `publishPortal` 路径**拒绝 `sceneVersion === 1` 草稿，避免误用旧 API 发布 V1。
8. **无实时多人光标**；无私有素材 CDN，一律私有存储 + 鉴权文件 API。
9. **员工不可见草稿**；管理员可预览刚上传未引用的门户图（产品选择，见文件路由注释）。
10. **精确调整条**在极小 zoom 时可能宽于画布 CSS 宽，依赖 host `overflow: visible` 与滚动容器，而非把按钮缩进画布内。

---

## 13. API 速查

| 方法 | 路径 | 角色 |
|------|------|------|
| GET/PATCH/POST | `/api/admin/portal/:city/draft` | 管理员 |
| POST | `/api/admin/portal/:city/publish` | 管理员 |
| GET | `/api/admin/portal/:city/history` | 管理员 |
| POST | `/api/admin/portal/:city/restore` | 管理员 |
| GET/POST/DELETE | `/api/admin/portal/:city/assets` | 管理员 |
| GET | `/api/portal/:city?viewport=` | 员工 + GUIDES 模块 |
| GET | `/api/files/:assetId` | 会话 + 资产授权 |

---

## 14. 验证入口

门户行为由 `tests/portal/`、`tests/ui/`、`tests/routes/portal-routes.test.ts`、`tests/scripts/migrate-portal-scenes.test.ts` 与 `e2e/portal-editor.spec.ts` 覆盖。修改场景 schema、几何、发布、素材授权或迁移逻辑时，应先运行对应窄测试，再运行完整 `pnpm test` 与 `pnpm test:e2e`。

## 15. 文档维护说明

- 行为变化应同步更新本文件和相关迁移说明。
- 迁移细节以 `docs/migrations/2026-07-25-portal-scene-v1.md` 为权威运维手册。
- 本文档不记录本机截图、评审会话、模型输出或私有运行证据。
