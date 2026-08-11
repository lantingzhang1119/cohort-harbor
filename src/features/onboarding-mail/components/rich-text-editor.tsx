"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import Image from "@tiptap/extension-image";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";

export type RichTextImageRequest = { contentId: string; alt: string; nonce: number };

export function RichTextEditor({ value, onChange, imageRequest }: { value: string; onChange: (html: string) => void; imageRequest?: RichTextImageRequest | null }) {
  const editor = useEditor({
    extensions: [StarterKit, Image.configure({ allowBase64: false })],
    content: value,
    immediatelyRender: false,
    editorProps: { attributes: { "aria-label": "富文本正文", role: "textbox", class: "mail-tiptap-content" } },
    onUpdate: ({ editor: current }) => onChange(current.getHTML()),
  });

  useEffect(() => {
    if (editor && editor.getHTML() !== value) editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    if (!editor || !imageRequest || !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,126}$/.test(imageRequest.contentId)) return;
    editor.chain().setImage({ src: `cid:${imageRequest.contentId}`, alt: imageRequest.alt }).run();
  }, [editor, imageRequest]);

  return (
    <div className="mail-rich-editor">
      <div className="mail-rich-toolbar" aria-label="富文本工具栏">
        <button type="button" aria-label="加粗" aria-pressed={editor?.isActive("bold") ?? false} onClick={() => editor?.chain().focus().toggleBold().run()}><strong>B</strong></button>
        <button type="button" aria-label="斜体" aria-pressed={editor?.isActive("italic") ?? false} onClick={() => editor?.chain().focus().toggleItalic().run()}><em>I</em></button>
        <button type="button" aria-label="项目符号列表" aria-pressed={editor?.isActive("bulletList") ?? false} onClick={() => editor?.chain().focus().toggleBulletList().run()}>• 列表</button>
        <button type="button" aria-label="撤销" onClick={() => editor?.chain().focus().undo().run()}>撤销</button>
        <button type="button" aria-label="重做" onClick={() => editor?.chain().focus().redo().run()}>重做</button>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
