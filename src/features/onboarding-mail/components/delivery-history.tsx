"use client";

import { useMemo, useState } from "react";

export type Delivery = {
  id: string; status: string; statusLabel: string; source: string; recipientEmailSnapshot: string; createdAt: string;
  failureCode?: string | null;
  errorSummary?: string | null;
  unknownResolution?: string | null;
  resendDelivery?: { id: string } | null;
};

const ERROR_SUMMARY_LIMIT = 180;

function safeFailureCode(value: string | null | undefined): string | null {
  const code = value?.trim();
  if (!code) return null;
  return /^[A-Z0-9_:-]{1,80}$/.test(code) ? code : "UNRECOGNIZED_FAILURE";
}

function safeErrorSummary(value: string | null | undefined): string | null {
  if (!value) return null;
  const redacted = value
    .replace(/(smtps?:\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1[redacted]@")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
    .replace(/(["']?\b(?:providerMessageId|messageId|queueId)\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, "$1[redacted]")
    .replace(/(["']?(?:(?:smtp|api|auth)[_-]?)?(?:password|passwd|pwd|token|secret|authorization|auth)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;}\]]+)/gi, "$1[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\s+/g, " ")
    .trim();
  if (!redacted) return null;
  return redacted.length > ERROR_SUMMARY_LIMIT
    ? `${redacted.slice(0, ERROR_SUMMARY_LIMIT).trimEnd()}…`
    : redacted;
}

export function DeliveryHistory({ initialDeliveries, localDate, truncated = false }: { initialDeliveries: Delivery[]; localDate: string; truncated?: boolean }) {
  const [deliveries, setDeliveries] = useState(initialDeliveries);
  const [status, setStatus] = useState("ALL");
  const [message, setMessage] = useState("");
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const visible = useMemo(() => status === "ALL" ? deliveries : deliveries.filter((item) => item.status === status), [deliveries, status]);

  function setPending(deliveryId: string, value: boolean) {
    setPendingIds((current) => {
      const next = new Set(current);
      if (value) next.add(deliveryId); else next.delete(deliveryId);
      return next;
    });
  }

  async function action(url: string, body: unknown, success: string, deliveryId: string, update: (delivery: Delivery) => Delivery, alreadyConfirmed = false) {
    if (!alreadyConfirmed && !window.confirm("该操作会写入投递历史，是否继续？")) return;
    setPending(deliveryId, true);
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json();
      setMessage(response.ok ? success : payload.message ?? "操作失败");
      if (response.ok) setDeliveries((items) => items.map((item) => item.id === deliveryId ? update(item) : item));
    } finally {
      setPending(deliveryId, false);
    }
  }

  async function resend(deliveryId: string) {
    if (!window.confirm("该操作会写入投递历史，是否继续？")) return;
    setPending(deliveryId, true);
    try {
      const confirmationResponse = await fetch("/api/admin/onboarding-mail/confirmations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "RESEND", localDate, selectedIds: [deliveryId] }),
      });
      const confirmation = await confirmationResponse.json();
      if (!confirmationResponse.ok || !confirmation.confirmationToken) {
        setMessage(confirmation.message ?? "无法确认重发选择");
        return;
      }
      const response = await fetch("/api/admin/onboarding-mail/resend", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deliveryIds: [deliveryId], localDate, displayedRecipientCount: 1, confirmed: true,
          confirmationToken: confirmation.confirmationToken,
        }),
      });
      const payload = await response.json();
      setMessage(response.ok ? "已创建重发" : payload.message ?? "操作失败");
      if (response.ok) setDeliveries((items) => items.map((item) => item.id === deliveryId ? { ...item, resendDelivery: { id: "created" } } : item));
    } finally {
      setPending(deliveryId, false);
    }
  }

  return (
    <section className="mail-history-panel">
      <header><div><p className="eyebrow">可审计投递</p><h2>发送记录</h2></div><label>发送状态筛选<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="ALL">全部</option><option value="PENDING">待发送</option><option value="SENT">已发送</option><option value="FAILED">发送失败</option><option value="UNKNOWN">结果未确认</option></select></label></header>
      {truncated ? <p role="note">发送记录仅显示最近 200 条，请使用状态筛选缩小范围。</p> : null}
      <div className="mail-history-list">{visible.map((delivery) => {
        const failureCode = safeFailureCode(delivery.failureCode);
        const errorSummary = safeErrorSummary(delivery.errorSummary);
        return (
        <article key={delivery.id} data-testid={`delivery-${delivery.id}`} className={delivery.status === "UNKNOWN" ? "mail-unknown-row" : ""}>
          <div><strong>{delivery.recipientEmailSnapshot}</strong><span>{delivery.source} · {new Date(delivery.createdAt).toLocaleString("zh-CN")}</span>{failureCode || errorSummary ? <div className="mail-failure-diagnostic" aria-label="失败诊断">{failureCode ? <span>失败代码 <code>{failureCode}</code></span> : null}{errorSummary ? <span className="mail-failure-summary">{errorSummary}</span> : null}</div> : null}</div>
          <b>{delivery.statusLabel}</b>
          <div className="mail-row-actions">
            {delivery.status === "FAILED" ? <button type="button" disabled={pendingIds.has(delivery.id)} onClick={() => action("/api/admin/onboarding-mail/retry", { deliveryIds: [delivery.id], confirmed: true }, "已安排重试", delivery.id, (item) => ({ ...item, status: "PENDING", statusLabel: "待发送" }))}>重试</button> : null}
            {delivery.status === "SENT" && !delivery.resendDelivery ? <button type="button" disabled={pendingIds.has(delivery.id)} onClick={() => resend(delivery.id)}>再次发送</button> : null}
            {delivery.status === "UNKNOWN" && !delivery.unknownResolution ? <><button type="button" disabled={pendingIds.has(delivery.id)} onClick={() => action(`/api/admin/onboarding-mail/unknown/${delivery.id}/resolve`, { action: "CONFIRMED_DELIVERED", note: "管理员在邮件中心确认已送达", confirmed: true }, "已记录确认送达", delivery.id, (item) => ({ ...item, unknownResolution: "CONFIRMED_DELIVERED" }))}>确认已送达</button><button type="button" disabled={pendingIds.has(delivery.id)} onClick={() => action(`/api/admin/onboarding-mail/unknown/${delivery.id}/resolve`, { action: "CONFIRMED_FAILED_RESEND", note: "管理员在邮件中心确认失败并重发", confirmed: true }, "已记录失败并创建重发", delivery.id, (item) => ({ ...item, unknownResolution: "CONFIRMED_FAILED_RESEND", resendDelivery: { id: "created" } }))}>确认失败并重发</button></> : null}
          </div>
        </article>
        );
      })}</div>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
