# 四地入职指南 Portal Scene V1 数据迁移

本迁移把现有四城门户的旧 Logo/图片布局安全转换为 Portal Scene V1，同时
保留旧 JSON、历史发布和私有素材。迁移不会发送邮件、删除素材或新增破坏性
数据库结构。

## 适用范围

- 四个城市：上海、深圳、长沙、西安；
- 两种视口：`DESKTOP`、`MOBILE`；
- `GuidePortalDraft` 草稿；
- `GuidePortalPublication` 全部历史发布；
- 可由这些场景访问到的 `PORTAL_IMAGE` 素材和素材引用。

迁移会为每个城市、每个视口给出最新发布状态：

- `V1`：已是 V1 或本次安全转换为 V1；
- `V0_FALLBACK`：旧发布被明确保留，由兼容页面继续展示；
- `NO_PUBLICATION`：该城市、视口尚无发布。

## 安全边界

1. 旧发布按 `(city, version)` 成对处理。只有桌面和手机都存在、都能解析且
   所有素材都通过检查时，才会一起转换为 V1。
2. 旧发布缺少一个视口、场景为空，或任一素材缺失、损坏、类型不正确时，
   整对保持 v0 fallback。空发布不能转换为会抑制旧指南章节的 V1 空页面。
3. V1/v0 混合发布、V1 缺半、非法 V1 场景或 V1 引用不安全素材属于致命
   完整性错误，命令非零退出。
4. 草稿可按视口独立转换。首次转换保存 `legacyElements` 并只增加一次
   `draftRevision`。
5. 无法检查的旧素材不会移动或删除，状态记为 `LEGACY_UNINSPECTED`。
6. 可安全推导的草稿和全部历史发布引用会被精确重建；无法解析的旧记录保留
   现有引用，缺失素材不创建虚假引用。
7. `--dry-run` 不写数据库、不创建备份和审计文件。
8. 正式执行仅在存在实际变更时创建备份。重复执行已经完成的数据库返回
   `NOOP`，不再创建备份或增加 revision。
9. 数据库中出现四城以外的草稿或发布属于范围完整性错误：命令在创建备份和
   写数据库之前直接退出，不会静默转换或遗漏审计矩阵。

## 执行前准备

1. 停止 Web 服务、邮件 worker 和所有可能写入数据库的进程。
2. 确认 Node.js 为项目锁定的 24.x 版本。
3. 先完成 Prisma 加法迁移：

   ```bash
   pnpm db:migrate
   ```

4. 确认数据库和私有存储目录都是真实的绝对路径，不是符号链接。
5. 不要删除 SQLite 的现有数据库、`-wal` 或 `-shm` 文件；迁移使用 SQLite
   在线备份收集已经提交的 WAL 内容。

## 先执行 dry-run

```bash
pnpm portal:migrate -- \
  --database /absolute/path/to/storage/private/demo.db \
  --private-root /absolute/path/to/storage/private \
  --dry-run
```

dry-run 在显式 SQLite 只读事务快照中读取所有计划输入。输出只包含计数、
四城双视口状态、有限错误代码和经固定域 SHA-256 截短的 `assetRef`，不包含
原始素材 ID、员工信息、页面正文、`storageKey` 或绝对文件路径。

重点检查：

- `fallbackPublicationPairs` 是否符合预期；
- `latestMatrix` 的八个城市/视口状态；
- `findings` 中是否存在 `ASSET_FILE_MISSING`、`ASSET_INVALID`、
  `INCOMPLETE_LEGACY_PAIR` 或 `LEGACY_ROW_INVALID`。

这些 v0 fallback 是安全保留，不等于迁移事务失败。V1 成对不一致、数据库
完整性错误、迁移账本不匹配等会直接非零退出。

## 正式执行

确认 dry-run 结果后，去掉 `--dry-run`：

```bash
pnpm portal:migrate -- \
  --database /absolute/path/to/storage/private/demo.db \
  --private-root /absolute/path/to/storage/private
```

有实际变更时，数据库同目录会新增：

- `portal-scene-v1-<时间>-<随机标识>.backup.sqlite`；
- `portal-scene-v1-<时间>-<随机标识>.json`。

JSON 审计只记录安全计数、状态、备份文件名和 SHA-256，不记录绝对路径、
数据库原文件名、原始素材 ID、员工信息或页面正文。备份、审计文件使用
不可覆盖的新名称和 `0600` 权限。

执行期间命令会：

1. 校验 Prisma migration ledger、DDL 列、SQLite 完整性和外键；
2. 在构建迁移计划之前取得同目录维护锁，并在同一个 SQLite 只读事务快照中
   读取草稿、发布、素材、元数据、引用及输入指纹；
3. 通过 `O_NOFOLLOW` 安全句柄检查每个可达素材，记录
   device/inode/size/mtime/ctime、实际 SHA-256、MIME 与图片结构结果；
4. 取得 `BEGIN IMMEDIATE`，重新比较同一输入集合的数据库指纹，并在任何
   数据库写入前重新打开、完整读取和核验全部计划素材；
5. 在写锁内、首个数据库变更前以 `O_EXCL/O_NOFOLLOW` 原子预留固定安全名称的
   `0600` 普通文件，再让 SQLite 写入该同一 inode；复制进度中和完成后都会复核
   文件类型、inode 与权限并验证备份，复制失败会删除本次预留的残缺副本；
6. 预先创建、`fsync` 一个 `0600` 的 `PENDING` 审计文件；
7. 原子写入元数据、场景转换和引用，并在提交前再次完整核验素材、外键、
   SQLite 完整性和 V1 发布成对约束；
8. 把目标数据库指纹持久化到 `PENDING` 审计文件，再进行一次紧贴
   `COMMIT` 的素材核验，并同步复核备份仍为预留的同一 inode、普通文件和
   `0600` 权限后提交数据库，最后原子完成 `COMMITTED` 审计文件。

任何事务内失败都会回滚全部数据库变更。复制失败的残缺备份或校验失败的无效
备份会被安全移除；备份校验成功后即使后续事务失败，保留的迁移前备份也始终是
`0600` 普通文件。如果同账号进程在提交前改变本次备份的权限或文件身份，迁移
会回滚并仅按预留 inode 清理本次拥有的不安全副本，不会删除替换进来的外部文件。

如果数据库已经 `COMMIT`、但最终审计文件替换失败，命令不会模糊地报告普通
失败，而会输出：

- `status: COMMITTED_WITH_AUDIT_WARNING`；
- `auditState: PENDING`；
- `auditWarning: AUDIT_FINALIZE_FAILED`。

此时数据库已迁移，不能按“已回滚”处理；保留的 `PENDING` 文件含源/目标指纹。
在不修改数据库的前提下重新执行相同命令，迁移会匹配目标指纹、补全原审计
文件，并以幂等 `NOOP` 结束。

素材身份与内容核验保护的是本次迁移从计划、写入到提交的执行窗口。迁移完成
后，素材文件仍必须由私有存储目录权限、部署账号最小权限和服务停写流程保护；
迁移脚本不是长期文件防篡改守护程序。

## 验证

```bash
pnpm portal:migrate -- \
  --database /absolute/path/to/storage/private/demo.db \
  --private-root /absolute/path/to/storage/private \
  --dry-run
```

完成后的再次 dry-run 应显示零转换、零元数据变化、零引用变化。然后启动应用，
逐城检查桌面和手机员工页面，特别确认：

- v0 fallback 页面仍能加载原私有图片；
- V1 页面桌面/手机来自同一发布版本；
- 历史发布素材仍受引用保护；
- 素材异常记录不会在 V1 编辑器中重新选择。

## 数据库恢复

恢复会覆盖迁移后的数据库状态，必须先停止所有写入。

1. 记录当前数据库、`-wal`、`-shm` 状态并移到单独的人工隔离目录，不要直接
   删除。
2. 使用审计 JSON 中的 `backupFile` 和 `backupSha256` 验证备份。
3. 对备份执行 SQLite `integrity_check` 和 `foreign_key_check`。
4. 把经过验证的备份复制回原数据库路径，并保持原文件权限。
5. 确认原路径没有遗留的旧 `-wal`、`-shm` 后再启动应用。

迁移不会修改任何素材文件，因此数据库恢复不要求恢复私有素材目录；但恢复前
仍应确认私有素材没有在迁移执行后被其他进程替换。

## 应用二进制回滚分级

- 数据回滚安全：迁移前备份、旧列、旧 JSON、旧发布和素材均保留。
- 首次 V1 发布前：旧应用二进制可以继续读取旧图片布局。
- 首次 V1 发布后：旧二进制只能读取图片降级投影，无法语义等价呈现文字、
  按钮、线条等 V1 元素，不能宣称安全回滚。
- 如果首次 V1 发布后必须退回旧二进制，应停止写入，同时恢复首次 V1 发布前
  的数据库备份；必须保留当前新代码构建和只读 V1 渲染能力。
