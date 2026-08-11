"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

import type { Role, UserStatus } from "@/generated/prisma/enums";
import {
  isOperationallyActiveAdmin,
  partitionOrdinaryAdminAccounts,
  type AdminOperationalState,
} from "@/features/admin-accounts/lifecycle";
import { isValidNewPassword } from "@/features/auth/password-policy";

export {
  isOperationallyActiveAdmin,
  partitionOrdinaryAdminAccounts,
} from "@/features/admin-accounts/lifecycle";

type AdminAccount = {
  id: string;
  employeeNo: string;
  name: string;
  email: string | null;
  role: Role;
  status: UserStatus;
  enabled: boolean;
  mustChangePassword: boolean;
  adminArchivedAt: string | null;
};

type IdentityFields = {
  employeeNo: string;
  name: string;
  email: string;
};

type DialogState =
  | { type: "create" }
  | { type: "transfer"; admin: AdminAccount }
  | { type: "archive"; admin: AdminAccount }
  | { type: "restore"; admin: AdminAccount }
  | { type: "delete"; admin: AdminAccount }
  | null;

const emptyIdentity: IdentityFields = { employeeNo: "", name: "", email: "" };

export function postTransferDestination(role: Role): "/login" | null {
  return role === "SUPER_ADMIN" ? "/login" : null;
}

export function adminAccountStatusLabel(account: AdminOperationalState): string {
  if (isOperationallyActiveAdmin(account)) return "可登录";
  return account.adminArchivedAt ? "已归档" : "已停用";
}

async function readResult(response: Response) {
  const result = await response.json() as unknown;
  if (!result || typeof result !== "object" || !("ok" in result) || typeof result.ok !== "boolean") {
    throw new Error("管理员账号接口返回了无效响应");
  }
  return result as {
    ok: boolean;
    message?: string;
    items?: AdminAccount[];
    admin?: AdminAccount;
    temporaryPassword?: string;
  };
}

export function AdminAccountManager() {
  const [items, setItems] = useState<AdminAccount[]>([]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [identity, setIdentity] = useState<IdentityFields>(emptyIdentity);
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [issuedCredential, setIssuedCredential] = useState<{
    adminName: string;
    temporaryPassword: string;
  } | null>(null);
  const [message, setMessage] = useState("正在加载管理员账号…");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/administrators");
      const result = await readResult(response);
      if (response.ok && result.ok) {
        setItems(result.items ?? []);
        setMessage(result.items?.length ? "" : "暂无管理员账号");
        return true;
      }
      setMessage(result.message ?? "管理员账号加载失败，请刷新页面重试");
    } catch {
      setMessage("管理员账号加载失败，请刷新页面重试");
    }
    return false;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/administrators", { signal: controller.signal })
      .then(readResult)
      .then((result) => {
        if (result.ok) {
          setItems(result.items ?? []);
          setMessage(result.items?.length ? "" : "暂无管理员账号");
        } else {
          setMessage(result.message ?? "管理员账号加载失败");
        }
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setMessage("管理员账号加载失败，请刷新页面重试");
        }
      });
    return () => controller.abort();
  }, []);

  function openCreate() {
    setIdentity(emptyIdentity);
    setDialog({ type: "create" });
  }

  function openTransfer(admin: AdminAccount) {
    setIdentity({ employeeNo: admin.employeeNo, name: admin.name, email: admin.email ?? "" });
    setTemporaryPassword("");
    setCurrentPassword("");
    setDialog({ type: "transfer", admin });
  }

  function closeDialog() {
    setDialog(null);
    setTemporaryPassword("");
    setCurrentPassword("");
    setConfirmation("");
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const response = await fetch("/api/admin/administrators", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(identity),
      });
      const result = await readResult(response);
      if (!response.ok || !result.ok || !result.admin || !result.temporaryPassword) {
        setMessage(result.message ?? "创建失败");
        return;
      }
      setIssuedCredential({
        adminName: result.admin.name,
        temporaryPassword: result.temporaryPassword,
      });
      closeDialog();
      if (await load()) setMessage("管理员账号已创建");
    } catch {
      setMessage("创建失败，请检查网络连接后重试");
    } finally {
      setSubmitting(false);
    }
  }

  async function transfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (dialog?.type !== "transfer") return;
    if (!isValidNewPassword(temporaryPassword)) {
      setMessage("新临时密码至少 8 位，且必须同时包含英文字母和数字");
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch(`/api/admin/administrators/${dialog.admin.id}/transfer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...identity, temporaryPassword, currentPassword }),
      });
      const result = await readResult(response);
      if (!response.ok || !result.ok) {
        setMessage(result.message ?? "账号接管失败");
        return;
      }
      const destination = postTransferDestination(dialog.admin.role);
      closeDialog();
      if (destination) {
        window.location.assign(destination);
        return;
      }
      if (await load()) setMessage("管理员账号已完成接管，旧会话已失效");
    } catch {
      setMessage("账号接管失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  async function mutate(path: string, successMessage: string, body: object = {}) {
    setSubmitting(true);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await readResult(response);
      if (!response.ok || !result.ok) {
        setMessage(result.message ?? "操作失败");
        return;
      }
      closeDialog();
      if (await load()) setMessage(successMessage);
    } catch {
      setMessage("操作失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  const { active, disabled } = partitionOrdinaryAdminAccounts(items);
  const superAdministrator = items.find((item) => item.role === "SUPER_ADMIN");

  function renderRows(accounts: AdminAccount[]) {
    return accounts.map((admin) => (
      <tr key={admin.id}>
        <td><strong>{admin.name}</strong><span>{admin.employeeNo}</span></td>
        <td>{admin.email ?? "未提供邮箱"}</td>
        <td>
          <span className={isOperationallyActiveAdmin(admin) ? "tag success" : "tag muted"}>
            {adminAccountStatusLabel(admin)}
          </span>
        </td>
        <td>
          <div className="row-actions">
            <button type="button" onClick={() => openTransfer(admin)}>账号接管</button>
            {isOperationallyActiveAdmin(admin) ? (
              <button type="button" onClick={() => setDialog({ type: "archive", admin })}>归档账号</button>
            ) : (
              <button type="button" onClick={() => setDialog({ type: "restore", admin })}>恢复账号</button>
            )}
            <button className="danger-action" type="button" onClick={() => {
              setCurrentPassword("");
              setConfirmation("");
              setDialog({ type: "delete", admin });
            }}>永久删除</button>
          </div>
        </td>
      </tr>
    ));
  }

  return (
    <main className="admin-content administrator-page">
      <header className="page-title-row">
        <div>
          <p className="eyebrow">SECURITY · 管理权限</p>
          <h1>管理员账号</h1>
          <p>创建管理员、账号接管、归档账号、恢复账号与永久删除管理员。</p>
        </div>
        <button className="primary-action" type="button" onClick={openCreate}>创建管理员</button>
      </header>

      <p className="status-message" aria-live="polite">{message}</p>

      {issuedCredential && (
        <section className="credential-panel" aria-label="一次性临时密码">
          <div>
            <strong>一次性临时密码</strong>
            <p>请立即安全交给 {issuedCredential.adminName}。关闭后无法再次查看。</p>
          </div>
          <code>{issuedCredential.temporaryPassword}</code>
          <button type="button" onClick={() => setIssuedCredential(null)}>我已保存，关闭</button>
        </section>
      )}

      {superAdministrator && (
        <section className="admin-account-section">
          <h2>超级管理员</h2>
          <article className="super-admin-card">
            <div><strong>{superAdministrator.name}</strong><span>{superAdministrator.employeeNo} · {superAdministrator.email}</span></div>
            <button type="button" onClick={() => openTransfer(superAdministrator)}>账号接管</button>
          </article>
        </section>
      )}

      <section className="admin-account-section">
        <h2>启用中的普通管理员 <span>{active.length}</span></h2>
        <div className="employee-table-wrap">
          <table className="employee-table">
            <thead><tr><th>管理员</th><th>邮箱</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>{renderRows(active)}</tbody>
          </table>
          {!active.length && <p className="empty-state">暂无启用中的普通管理员</p>}
        </div>
      </section>

      <section className="admin-account-section">
        <h2>已归档 / 停用管理员 <span>{disabled.length}</span></h2>
        <div className="employee-table-wrap">
          <table className="employee-table">
            <thead><tr><th>管理员</th><th>邮箱</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>{renderRows(disabled)}</tbody>
          </table>
          {!disabled.length && <p className="empty-state">暂无已归档或停用管理员</p>}
        </div>
      </section>

      <dialog className="admin-dialog" open={dialog?.type === "create"}>
        <form onSubmit={(event) => void create(event)}>
          <header><div><p className="eyebrow">CREATE</p><h2>创建管理员</h2></div><button type="button" onClick={closeDialog}>关闭</button></header>
          <IdentityInputs value={identity} onChange={setIdentity} />
          <p>系统将生成一次性临时密码，并要求管理员首次登录后修改。</p>
          <footer><button type="button" onClick={closeDialog}>取消</button><button className="primary-action" disabled={submitting} type="submit">确认创建</button></footer>
        </form>
      </dialog>

      <dialog className="admin-dialog" open={dialog?.type === "transfer"}>
        <form onSubmit={(event) => void transfer(event)}>
          <header><div><p className="eyebrow">TRANSFER</p><h2>账号接管</h2></div><button type="button" onClick={closeDialog}>关闭</button></header>
          <p>账号 ID、权限和历史记录保持不变，所有旧会话立即失效。</p>
          <IdentityInputs value={identity} onChange={setIdentity} />
          <label><span>新临时密码</span><input required minLength={8} pattern="(?=.*[A-Za-z])(?=.*\d).{8,}" type="password" autoComplete="new-password" value={temporaryPassword} onChange={(event) => setTemporaryPassword(event.target.value)} /></label>
          <label><span>当前超级管理员密码</span><input required type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
          <footer><button type="button" onClick={closeDialog}>取消</button><button className="primary-action" disabled={submitting} type="submit">确认接管</button></footer>
        </form>
      </dialog>

      <dialog className="admin-dialog" open={dialog?.type === "archive" || dialog?.type === "restore"}>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!dialog || (dialog.type !== "archive" && dialog.type !== "restore")) return;
          const action = dialog.type;
          void mutate(
            `/api/admin/administrators/${dialog.admin.id}/${action}`,
            action === "archive" ? "管理员账号已归档" : "管理员账号已恢复",
          );
        }}>
          <header><h2>{dialog?.type === "archive" ? "归档账号" : "恢复账号"}</h2><button type="button" onClick={closeDialog}>关闭</button></header>
          <p>{dialog && "admin" in dialog ? `确认处理 ${dialog.admin.name}（${dialog.admin.employeeNo}）？` : ""}</p>
          <footer><button type="button" onClick={closeDialog}>取消</button><button className="primary-action" disabled={submitting} type="submit">确认</button></footer>
        </form>
      </dialog>

      <dialog className="admin-dialog danger-dialog" open={dialog?.type === "delete"}>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (dialog?.type !== "delete") return;
          void mutate(
            `/api/admin/administrators/${dialog.admin.id}/permanent-delete`,
            "管理员账号已永久删除",
            { currentPassword, confirmation },
          );
        }}>
          <header><h2>永久删除管理员</h2><button type="button" onClick={closeDialog}>关闭</button></header>
          <p>此操作不可撤销。历史记录将保留身份快照，但登录账号会被物理删除。</p>
          <label><span>当前超级管理员密码</span><input required type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
          <label><span>输入“永久删除管理员”确认</span><input required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
          <footer><button type="button" onClick={closeDialog}>取消</button><button className="danger-action" disabled={submitting || confirmation !== "永久删除管理员"} type="submit">永久删除</button></footer>
        </form>
      </dialog>
    </main>
  );
}

function IdentityInputs({
  value,
  onChange,
}: {
  value: IdentityFields;
  onChange: (value: IdentityFields) => void;
}) {
  return (
    <div className="form-grid">
      <label><span>工号</span><input required value={value.employeeNo} onChange={(event) => onChange({ ...value, employeeNo: event.target.value })} /></label>
      <label><span>姓名</span><input autoComplete="name" maxLength={80} minLength={2} placeholder="请输入真实姓名，例如：示例员工" required value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} /></label>
      <label className="full"><span>邮箱</span><input required type="email" value={value.email} onChange={(event) => onChange({ ...value, email: event.target.value })} /></label>
    </div>
  );
}
