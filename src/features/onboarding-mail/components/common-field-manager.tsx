"use client";

import { useState } from "react";

export type MailField = { key: string; kind: "BUILTIN" | "CONSTANT"; label: string; enabled: boolean; sortOrder: number; required: boolean; dateFormat?: string | null; constantValue?: string | null };

export function CommonFieldManager({ initialFields }: { initialFields: MailField[] }) {
  const [fields, setFields] = useState(initialFields);
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [message, setMessage] = useState("");

  function addConstant() {
    if (!label.trim() || !value.trim()) { setMessage("请填写字段名称和固定内容"); return; }
    const suffix = label.normalize("NFKC").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || String(fields.length + 1);
    setFields([...fields, { key: `custom.${suffix}`, kind: "CONSTANT", label: label.trim(), constantValue: value.trim(), enabled: true, required: false, sortOrder: fields.length + 1 }]);
    setLabel(""); setValue(""); setMessage("");
  }

  async function save() {
    const response = await fetch("/api/admin/onboarding-mail/fields", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ fields }) });
    const payload = await response.json();
    setMessage(response.ok ? "常用字段已保存" : payload.message ?? "保存失败");
    if (response.ok) setFields(payload.fields ?? fields);
  }

  return (
    <section className="mail-fields-panel" aria-labelledby="mail-fields-heading">
      <header><div><p className="eyebrow">字段中心</p><h2 id="mail-fields-heading">常用字段</h2></div><button type="button" onClick={save}>保存字段设置</button></header>
      <div className="mail-field-grid">{fields.map((field, index) => (
        <article key={field.key}>
          <label><input type="checkbox" checked={field.enabled} onChange={(event) => setFields(fields.map((item, itemIndex) => itemIndex === index ? { ...item, enabled: event.target.checked } : item))} />启用 {field.label}</label>
          <code>{`{{${field.key}}}`}</code>
          {field.kind === "CONSTANT" ? <input aria-label={`${field.label}固定内容`} value={field.constantValue ?? ""} onChange={(event) => setFields(fields.map((item, itemIndex) => itemIndex === index ? { ...item, constantValue: event.target.value } : item))} /> : null}
        </article>
      ))}</div>
      <div className="mail-add-field"><label>字段名称<input value={label} onChange={(event) => setLabel(event.target.value)} /></label><label>固定内容<input value={value} onChange={(event) => setValue(event.target.value)} /></label><button type="button" onClick={addConstant}>添加固定字段</button></div>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
