// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";

import { FilePickerButton } from "@/lib/ui/file-picker-button";
import { BackButton } from "@/lib/ui/back-button";
import { WatermarkOverlay } from "@/lib/ui/watermark-overlay";
import { DocumentPreviewer } from "@/lib/ui/document-previewer";

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("reusable UI components", () => {
  it("renders FilePickerButton, allows file selection, displays filename, extension and size", async () => {
    const handleChange = vi.fn();
    render(<FilePickerButton name="testFile" accept=".pdf,.docx" buttonText="选择模版文件" onChange={handleChange} />);

    const button = screen.getByRole("button", { name: /选择模版文件/ });
    expect(button).toBeTruthy();

    const file = new File(["dummy content"], "test-manual.pdf", { type: "application/pdf" });
    const input = document.querySelector<HTMLInputElement>('input[type="file"][name="testFile"]')!;
    expect(input).toBeTruthy();

    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("test-manual.pdf")).toBeTruthy();
    expect(document.querySelector(".file-ext-badge")?.textContent).toBe(".pdf");
    expect(screen.getByText("(13 B)")).toBeTruthy();
    expect(handleChange).toHaveBeenCalledWith(file);

    const clearButton = screen.getByRole("button", { name: "清除已选文件" });
    fireEvent.click(clearButton);
    expect(screen.queryByText("test-manual.pdf")).toBeNull();
    expect(handleChange).toHaveBeenCalledWith(null);
  });

  it("renders BackButton with customizable href and text label", () => {
    render(<BackButton href="/employee/policies" label="返回制度列表" />);
    const link = screen.getByRole("link", { name: "← 返回制度列表" });
    expect(link.getAttribute("href")).toBe("/employee/policies");
  });

  it("renders WatermarkOverlay with custom watermark text and opacity", () => {
    const { container } = render(
      <WatermarkOverlay name="示例员工" opacity={0.1}>
        <div>预览内容</div>
      </WatermarkOverlay>
    );
    expect(screen.getByText("预览内容")).toBeTruthy();
    expect(container.querySelector(".watermark-layer")).toBeTruthy();
    expect(screen.getAllByText(/示例员工/).length).toBeGreaterThan(0);
  });

  it("renders DocumentPreviewer with BackButton and page controls", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    render(
      <DocumentPreviewer
        fileUrl="/api/policies/p1/content"
        previewFormat="TEXT"
        watermarkName="李四"
        backHref="/employee/policies"
        backLabel="返回制度列表"
        title="员工守则"
      />
    );

    expect(screen.getByRole("link", { name: "← 返回制度列表" })).toBeTruthy();
    expect(screen.getByText("员工守则")).toBeTruthy();
    expect(screen.getAllByText(/李四/).length).toBeGreaterThan(0);
  });

  it("syncs an external preview status message after the initial render", async () => {
    const view = render(
      <DocumentPreviewer
        fileUrl="/api/policies/p1/content"
        previewFormat={null}
        watermarkName="示例员工"
        message="正在打开制度文件…"
      />,
    );

    expect(screen.getByRole("status").textContent).toBe("正在打开制度文件…");
    view.rerender(
      <DocumentPreviewer
        fileUrl="/api/policies/p1/content"
        previewFormat={null}
        watermarkName="示例员工"
        message=""
      />,
    );

    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });
});
