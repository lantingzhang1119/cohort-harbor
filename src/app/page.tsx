import Link from "next/link";
import Image from "next/image";

import { BRAND } from "@/lib/brand";

export default function LandingPage() {
  return (
    <main className="landing-shell">
      <section className="landing-card">
        <div className="brand-lockup">
          {/* Original project-owned SVG; no remote images are used. */}
          <Image
            src="/brand/cohort-harbor-mark.svg"
            alt={BRAND.name}
            width={466}
            height={254}
            priority
          />
          <span>员工入职与制度学习平台</span>
        </div>
        <div className="landing-copy">
          <p className="eyebrow">WELCOME ABOARD</p>
          <h1>从这里，开启你的入职学习旅程</h1>
          <p>
            四地入职指南、制度文件与入职学习考试集中在一个安全、清晰、易用的本地平台中。
          </p>
          <Link className="primary-action" href="/login">
            进入平台
          </Link>
        </div>
        <div className="orbit-art" aria-hidden="true">
          <span className="orbit orbit-one" />
          <span className="orbit orbit-two" />
          <span className="core-chip">CH</span>
          <span className="spark spark-one">✦</span>
          <span className="spark spark-two">✦</span>
        </div>
      </section>
    </main>
  );
}
