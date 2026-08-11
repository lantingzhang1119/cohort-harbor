import { BRAND } from "@/lib/brand";

export type BuiltInMailFieldKey =
  | "name"
  | "employeeNo"
  | "email"
  | "hiredAt"
  | "firstDepartment"
  | "secondDepartment"
  | "position"
  | "workLocation"
  | "currentDate"
  | "companyName";

export type MailFieldConfig = {
  key: string;
  kind: "BUILTIN" | "CONSTANT";
  label: string;
  enabled: boolean;
  sortOrder: number;
  required: boolean;
  dateFormat?: string | null;
  constantValue?: string | null;
};

export type MailFieldSource = {
  employeeNo: string;
  name: string;
  email: string | null;
  hiredAt: Date | null;
  firstDepartment: string | null;
  secondDepartment: string | null;
  position: string | null;
  workLocation: string;
};

export type ResolvedMailFields = {
  ordered: Array<{ key: string; label: string; value: string }>;
  values: Record<string, string>;
};

export type FieldRegistryErrorCode =
  | "UNKNOWN_FIELD"
  | "INVALID_FIELD_CONFIG"
  | "INVALID_DATE_FORMAT"
  | "DUPLICATE_FIELD"
  | "MISSING_REQUIRED_FIELD";

export class FieldRegistryError extends Error {
  constructor(
    public readonly code: FieldRegistryErrorCode,
    message: string,
    public readonly fieldKey?: string,
  ) {
    super(message);
    this.name = "FieldRegistryError";
  }
}

export const BUILT_IN_MAIL_FIELDS: ReadonlyArray<{ key: BuiltInMailFieldKey; label: string }> = [
  { key: "name", label: "姓名" },
  { key: "employeeNo", label: "工号" },
  { key: "email", label: "邮箱" },
  { key: "hiredAt", label: "入职日期" },
  { key: "firstDepartment", label: "一级部门" },
  { key: "secondDepartment", label: "二级部门" },
  { key: "position", label: "岗位" },
  { key: "workLocation", label: "工作地点" },
  { key: "currentDate", label: "当前日期" },
  { key: "companyName", label: "公司名称" },
] as const;

const BUILT_IN_KEYS = new Set<string>(BUILT_IN_MAIL_FIELDS.map(({ key }) => key));
const DATE_FIELDS = new Set<string>(["hiredAt", "currentDate"]);
const ALLOWED_DATE_FORMATS = new Set(["yyyy-MM-dd", "yyyy/MM/dd", "yyyy年M月d日", "M月d日"]);
const CONFIG_KEYS = new Set([
  "key", "kind", "label", "enabled", "sortOrder", "required", "dateFormat", "constantValue",
]);
const LOCATION_LABELS: Record<string, string> = {
  SHANGHAI: "上海",
  SHENZHEN: "深圳",
  CHANGSHA: "长沙",
  XIAN: "西安",
  UNSET: "",
};
const SHANGHAI_DATE_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function formatShanghaiDate(value: Date, dateFormat: string): string {
  const parts = Object.fromEntries(SHANGHAI_DATE_PARTS.formatToParts(value).map((part) => [part.type, part.value]));
  const month = String(Number(parts.month));
  const day = String(Number(parts.day));
  if (dateFormat === "yyyy-MM-dd") return `${parts.year}-${parts.month}-${parts.day}`;
  if (dateFormat === "yyyy/MM/dd") return `${parts.year}/${parts.month}/${parts.day}`;
  if (dateFormat === "yyyy年M月d日") return `${parts.year}年${month}月${day}日`;
  if (dateFormat === "M月d日") return `${month}月${day}日`;
  throw new FieldRegistryError("INVALID_DATE_FORMAT", "日期格式不在允许列表中");
}

function invalidConfig(field: Partial<MailFieldConfig>, message: string): never {
  throw new FieldRegistryError("INVALID_FIELD_CONFIG", message, field.key);
}

export function validateFieldConfig(config: MailFieldConfig[]): MailFieldConfig[] {
  const keys = new Set<string>();
  return config.map((field) => {
    if (!field || typeof field !== "object" || Object.keys(field).some((key) => !CONFIG_KEYS.has(key))) {
      return invalidConfig(field ?? {}, "字段配置包含不允许的属性");
    }
    if (keys.has(field.key)) {
      throw new FieldRegistryError("DUPLICATE_FIELD", "字段键不能重复", field.key);
    }
    keys.add(field.key);
    if (!field.key || !field.label || !Number.isSafeInteger(field.sortOrder)) {
      return invalidConfig(field, "字段键、标签和排序值无效");
    }
    if (field.kind === "BUILTIN") {
      if (!BUILT_IN_KEYS.has(field.key)) {
        throw new FieldRegistryError("UNKNOWN_FIELD", "内置字段不在封闭注册表中", field.key);
      }
      if (field.constantValue != null) return invalidConfig(field, "内置字段不能设置常量值");
    } else if (field.kind === "CONSTANT") {
      if (
        !/^custom\.[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/.test(field.key)
        || typeof field.constantValue !== "string"
        || !field.constantValue.trim()
        || /[\r\n]/.test(field.constantValue)
      ) {
        return invalidConfig(field, "自定义字段只允许非空常量");
      }
      if (field.dateFormat != null) return invalidConfig(field, "常量字段不能设置日期格式");
    } else {
      return invalidConfig(field, "未知字段类型");
    }
    if (field.dateFormat != null) {
      if (!DATE_FIELDS.has(field.key) || !ALLOWED_DATE_FORMATS.has(field.dateFormat)) {
        throw new FieldRegistryError("INVALID_DATE_FORMAT", "日期格式不在允许列表中", field.key);
      }
    }
    return { ...field };
  });
}

function builtInValue(
  key: BuiltInMailFieldKey,
  source: MailFieldSource,
  options: { now?: Date; companyName?: string },
  dateFormat?: string | null,
): string {
  if (key === "currentDate") return formatShanghaiDate(options.now ?? new Date(), dateFormat ?? "yyyy-MM-dd");
  if (key === "companyName") return options.companyName?.trim() || BRAND.name;
  if (key === "hiredAt") return source.hiredAt ? formatShanghaiDate(source.hiredAt, dateFormat ?? "yyyy-MM-dd") : "";
  if (key === "workLocation") return LOCATION_LABELS[source.workLocation] ?? source.workLocation;
  return source[key] ?? "";
}

export function resolveMailFields(
  config: MailFieldConfig[],
  source: MailFieldSource,
  options: { now?: Date; companyName?: string } = {},
): ResolvedMailFields {
  const validated = validateFieldConfig(config);
  const ordered: ResolvedMailFields["ordered"] = [];
  const values: Record<string, string> = {};
  for (const { field } of validated
    .map((field, index) => ({ field, index }))
    .filter(({ field }) => field.enabled)
    .sort((left, right) => left.field.sortOrder - right.field.sortOrder || left.index - right.index)) {
    const value = field.kind === "CONSTANT"
      ? field.constantValue!
      : builtInValue(field.key as BuiltInMailFieldKey, source, options, field.dateFormat);
    if (field.required && !value.trim()) {
      throw new FieldRegistryError("MISSING_REQUIRED_FIELD", "必填字段缺少值", field.key);
    }
    values[field.key] = value;
    ordered.push({ key: field.key, label: field.label, value });
  }
  return { ordered, values };
}
