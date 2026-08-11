import Link from "next/link";

const cityNames: Record<string, string> = {
  SHANGHAI: "上海",
  SHENZHEN: "深圳",
  CHANGSHA: "长沙",
  XIAN: "西安",
};

export function CityCard({
  city,
  title,
  summary,
  recommended,
}: {
  city: string;
  title: string;
  summary: string | null;
  recommended: boolean;
}) {
  return (
    <Link className="city-card" href={`/employee/guides/${city}`}>
      <span className="city-index">{cityNames[city]?.slice(0, 1)}</span>
      <div>
        <p>{recommended ? "为你推荐 · 当前工作地点" : cityNames[city]}</p>
        <h2>{title}</h2>
        <span>{summary ?? "查看成长时间轴、联系人、园区与办公指引"}</span>
      </div>
      <strong aria-hidden="true">→</strong>
    </Link>
  );
}
