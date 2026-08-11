import Link from "next/link";

import { GuideAdmin } from "@/features/guides/components/guide-admin";
import { PortalEditor } from "@/features/portal/components/portal-editor";

const cities = [
  { code: "SHANGHAI", label: "上海", index: "01", href: "/admin/guides/editor?city=SHANGHAI&viewport=DESKTOP" },
  { code: "SHENZHEN", label: "深圳", index: "02", href: "/admin/guides/editor?city=SHENZHEN&viewport=DESKTOP" },
  { code: "CHANGSHA", label: "长沙", index: "03", href: "/admin/guides/editor?city=CHANGSHA&viewport=DESKTOP" },
  { code: "XIAN", label: "西安", index: "04", href: "/admin/guides/editor?city=XIAN&viewport=DESKTOP" },
] as const;

export default function AdminGuidesPage() {
  return (
    <>
      <section className="admin-content" aria-label="四城可视化门户入口">
        <header className="page-title-row">
          <div>
            <p className="eyebrow">GUIDES · 可视化门户</p>
            <h1>四城入职门户</h1>
            <p>选择城市进入独立的沉浸式画布，为桌面与手机端制作欢迎页面。</p>
          </div>
        </header>
        <section className="city-grid" aria-label="选择城市进入可视化编辑器">
          {cities.map((city) => (
            <Link
              className="city-card"
              href={city.href}
              key={city.code}
            >
              <span className="city-index">{city.index}</span>
              <div>
                <p>VISUAL PORTAL</p>
                <h2>{city.label}</h2>
                <span>进入可视化编辑器，分别维护桌面与手机画布。</span>
              </div>
              <strong aria-hidden="true">→</strong>
            </Link>
          ))}
        </section>

        <header className="page-title-row" style={{ marginTop: 56 }}>
          <div>
            <p className="eyebrow">LEGACY · 兼容旧版内容</p>
            <h2>兼容旧版内容</h2>
            <p>原图片布局与章节编辑能力继续保留，可在迁移完成前照常使用。</p>
          </div>
        </header>
        <PortalEditor />
      </section>
      <GuideAdmin />
    </>
  );
}
