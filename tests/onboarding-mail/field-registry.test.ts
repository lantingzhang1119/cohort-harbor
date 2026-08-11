import { describe, expect, it } from "vitest";

import {
  BUILT_IN_MAIL_FIELDS,
  FieldRegistryError,
  resolveMailFields,
  validateFieldConfig,
  type MailFieldConfig,
} from "@/features/onboarding-mail/field-registry";

const employee = {
  employeeNo: "E-001",
  name: "示例员工",
  email: "ZHANG.SAN@example.invalid",
  hiredAt: new Date("2026-07-22T00:00:00.000Z"),
  firstDepartment: "研发中心",
  secondDepartment: "平台组",
  position: "工程师",
  workLocation: "SHANGHAI",
};

function field(overrides: Partial<MailFieldConfig> & Pick<MailFieldConfig, "key">): MailFieldConfig {
  return {
    key: overrides.key,
    kind: overrides.kind ?? "BUILTIN",
    label: overrides.label ?? overrides.key,
    enabled: overrides.enabled ?? true,
    sortOrder: overrides.sortOrder ?? 0,
    required: overrides.required ?? false,
    dateFormat: overrides.dateFormat,
    constantValue: overrides.constantValue,
  };
}

describe("welcome-mail closed field registry", () => {
  it("contains exactly the ten seeded roster-backed built-ins", () => {
    expect(BUILT_IN_MAIL_FIELDS.map((item) => item.key)).toEqual([
      "name",
      "employeeNo",
      "email",
      "hiredAt",
      "firstDepartment",
      "secondDepartment",
      "position",
      "workLocation",
      "currentDate",
      "companyName",
    ]);
  });

  it("rejects unknown built-ins and executable custom sources while accepting constants", () => {
    expect(() => validateFieldConfig([field({ key: "passwordHash" })]))
      .toThrowError(expect.objectContaining({ code: "UNKNOWN_FIELD" }));
    expect(() => validateFieldConfig([{
      ...field({ key: "custom.portal", kind: "CONSTANT", constantValue: "https://intranet.example" }),
      resolverExpression: "process.env.SECRET",
    } as MailFieldConfig])).toThrowError(expect.objectContaining({ code: "INVALID_FIELD_CONFIG" }));
    expect(validateFieldConfig([
      field({ key: "custom.team.portal", kind: "CONSTANT", label: "门户", constantValue: "https://intranet.example" }),
    ])).toHaveLength(1);
  });

  it("resolves enabled fields in stable configured order and supports allowed date formats", () => {
    const resolved = resolveMailFields([
      field({ key: "currentDate", sortOrder: 30, dateFormat: "yyyy年M月d日" }),
      field({ key: "name", sortOrder: 10 }),
      field({ key: "hiredAt", sortOrder: 20, dateFormat: "yyyy/MM/dd" }),
      field({ key: "position", sortOrder: 20, enabled: false }),
      field({ key: "companyName", sortOrder: 35 }),
      field({ key: "custom.portal", kind: "CONSTANT", sortOrder: 40, constantValue: "员工门户" }),
    ], employee, { now: new Date("2026-08-03T08:00:00.000Z"), companyName: "Example Organization" });

    expect(resolved.ordered).toEqual([
      { key: "name", label: "name", value: "示例员工" },
      { key: "hiredAt", label: "hiredAt", value: "2026/07/22" },
      { key: "currentDate", label: "currentDate", value: "2026年8月3日" },
      { key: "companyName", label: "companyName", value: "Example Organization" },
      { key: "custom.portal", label: "custom.portal", value: "员工门户" },
    ]);
    expect(resolved.values.position).toBeUndefined();
  });

  it.each([
    ["yyyy-MM-dd", "2026-07-22"],
    ["yyyy/MM/dd", "2026/07/22"],
    ["yyyy年M月d日", "2026年7月22日"],
    ["M月d日", "7月22日"],
  ])("formats hiredAt and currentDate in Asia/Shanghai for %s even when the process runs in Los Angeles", (dateFormat, expected) => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const instant = new Date("2026-07-22T00:30:00.000Z");
      const resolved = resolveMailFields([
        field({ key: "hiredAt", sortOrder: 1, dateFormat }),
        field({ key: "currentDate", sortOrder: 2, dateFormat }),
      ], { ...employee, hiredAt: instant }, { now: instant });
      expect(resolved.values.hiredAt).toBe(expected);
      expect(resolved.values.currentDate).toBe(expected);
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it("distinguishes required missing values from optional empty values", () => {
    const withoutDepartment = { ...employee, firstDepartment: null };
    expect(() => resolveMailFields([
      field({ key: "firstDepartment", required: true }),
    ], withoutDepartment, { companyName: "Example Organization" }))
      .toThrowError(expect.objectContaining({ code: "MISSING_REQUIRED_FIELD", fieldKey: "firstDepartment" }));

    expect(resolveMailFields([
      field({ key: "firstDepartment" }),
    ], withoutDepartment, { companyName: "Example Organization" }).values.firstDepartment).toBe("");
  });

  it("rejects duplicate keys, missing constants and unapproved date formats", () => {
    expect(() => validateFieldConfig([field({ key: "name" }), field({ key: "name" })]))
      .toThrow(FieldRegistryError);
    expect(() => validateFieldConfig([field({ key: "custom.empty", kind: "CONSTANT" })]))
      .toThrowError(expect.objectContaining({ code: "INVALID_FIELD_CONFIG" }));
    expect(() => validateFieldConfig([field({ key: "hiredAt", dateFormat: "yyyy 'at' HH:mm:ss" })]))
      .toThrowError(expect.objectContaining({ code: "INVALID_DATE_FORMAT" }));
    expect(() => validateFieldConfig([
      field({ key: "custom.header", kind: "CONSTANT", constantValue: "safe\r\nBcc: attacker@example.invalid" }),
    ])).toThrowError(expect.objectContaining({ code: "INVALID_FIELD_CONFIG" }));
  });
});
