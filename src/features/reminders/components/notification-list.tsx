"use client";

import { useEffect, useState } from "react";

type Notification = {
  id: string;
  title: string;
  body: string;
  href: string | null;
  createdAt: string;
  readAt: string | null;
};

export function NotificationList() {
  const [items, setItems] = useState<Notification[]>([]);
  useEffect(() => {
    void fetch("/api/notifications")
      .then((response) => response.json())
      .then((result: { notifications?: Notification[] }) => setItems(result.notifications ?? []));
  }, []);

  async function open(item: Notification) {
    if (!item.readAt) {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      setItems((current) => current.map((entry) =>
        entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry,
      ));
    }
    if (item.href) window.location.assign(item.href);
  }

  return (
    <section className="notification-list">
      {items.map((item) => (
        <article key={item.id} className={item.href ? "notification-clickable" : ""}>
          <span>{item.readAt ? "已读" : "新"}</span>
          <div>
            <h2>{item.title}</h2>
            <p>{item.body}</p>
            <small>{new Date(item.createdAt).toLocaleString("zh-CN")}</small>
            {item.href ? <button type="button" onClick={() => void open(item)}>查看任务</button> : null}
          </div>
        </article>
      ))}
    </section>
  );
}
