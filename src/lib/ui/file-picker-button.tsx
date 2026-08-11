"use client";

import React, { useRef, useState } from "react";
import { Paperclip, Upload, X } from "lucide-react";

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export type FilePickerButtonProps = {
  name: string;
  accept?: string;
  required?: boolean;
  onChange?: (file: File | null) => void;
  buttonText?: string;
  id?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
};

export function FilePickerButton({
  name,
  accept,
  required,
  onChange,
  buttonText = "选择文件",
  id,
  disabled = false,
  ariaLabel,
  className = "",
}: FilePickerButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    onChange?.(file);
  }

  function handleClear() {
    if (inputRef.current) {
      inputRef.current.value = "";
    }
    setSelectedFile(null);
    onChange?.(null);
  }

  const getExtension = (fileName: string) => {
    const lastDot = fileName.lastIndexOf(".");
    return lastDot !== -1 ? fileName.slice(lastDot).toLowerCase() : "";
  };

  return (
    <div className={`file-picker-container ${className}`.trim()}>
      <input
        ref={inputRef}
        type="file"
        name={name}
        id={id}
        accept={accept}
        required={required && !selectedFile}
        disabled={disabled}
        aria-label={ariaLabel ?? buttonText}
        onChange={handleFileChange}
        className="sr-only file-picker-hidden-input"
        tabIndex={-1}
      />
      <div className="file-picker-actions">
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className="file-picker-trigger-btn secondary-action"
        >
          <Upload className="w-4 h-4" aria-hidden="true" />
          <span>{buttonText}</span>
        </button>

        {selectedFile && (
          <div className="file-picker-selected-info">
            <Paperclip className="w-4 h-4 file-icon" aria-hidden="true" />
            <span className="file-name">{selectedFile.name}</span>
            <span className="file-ext-badge">{getExtension(selectedFile.name)}</span>
            <span className="file-size">({formatBytes(selectedFile.size)})</span>
            <button
              type="button"
              onClick={handleClear}
              className="file-clear-btn"
              aria-label="清除已选文件"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
              <span>清除</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
