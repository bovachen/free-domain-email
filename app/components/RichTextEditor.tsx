// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "@cloudflare/kumo";
import {
	ArrowClockwiseIcon,
	ArrowCounterClockwiseIcon,
	LinkBreakIcon,
	LinkSimpleIcon,
	ListBulletsIcon,
	ListNumbersIcon,
	MinusIcon,
	QuotesIcon,
	TextBIcon,
	TextItalicIcon,
	TextStrikethroughIcon,
	TextUnderlineIcon,
} from "@phosphor-icons/react";
import { Color } from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import TiptapImage from "@tiptap/extension-image";
import LinkExtension from "@tiptap/extension-link";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect } from "react";

interface RichTextEditorProps {
	value: string;
	onChange: (value: string) => void;
}

export default function RichTextEditor({
	value,
	onChange,
}: RichTextEditorProps) {
	const editor = useEditor({
		extensions: [
			StarterKit,
			Underline,
			TextAlign.configure({ types: ["heading", "paragraph"] }),
			LinkExtension.configure({ openOnClick: false }),
			TiptapImage,
			TextStyle,
			Color,
			Highlight.configure({ multicolor: true }),
		],
		content: value,
		editorProps: {
			attributes: {
				class:
					"prose prose-sm max-w-none focus:outline-none min-h-[180px] p-3 text-sm [&_blockquote]:border-l-2 [&_blockquote]:border-kumo-line [&_blockquote]:pl-3 [&_blockquote]:text-kumo-subtle [&_blockquote]:bg-kumo-tint [&_blockquote]:py-1 [&_blockquote]:my-2 [&_blockquote]:text-xs [&_blockquote]:rounded-r-sm",
			},
		},
		onUpdate: ({ editor }) => {
			onChange(editor.getHTML());
		},
	});

	useEffect(() => {
		if (editor && !editor.isDestroyed && value !== editor.getHTML()) {
			editor.commands.setContent(value);
			// Place cursor at the start of the document (above quoted text)
			const rafId = requestAnimationFrame(() => {
				if (!editor.isDestroyed) {
					editor.commands.focus('start');
				}
			});
			return () => cancelAnimationFrame(rafId);
		}
	}, [value, editor]);

	const setLink = useCallback(() => {
		if (!editor) return;
		const previousUrl = editor.getAttributes("link").href;
		const url = window.prompt("链接 URL", previousUrl);
		if (url === null) return;
		if (url === "") {
			editor.chain().focus().extendMarkRange("link").unsetLink().run();
			return;
		}
		editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
	}, [editor]);

	if (!editor) return null;

	return (
		<div className="rounded-lg border border-kumo-line overflow-hidden flex flex-col h-full">
			{/* Toolbar */}
			<div className="flex flex-wrap items-center gap-0.5 bg-kumo-recessed px-2 py-1.5 border-b border-kumo-line shrink-0">
				{/* Text formatting */}
				<Tooltip content="粗体" side="bottom" asChild>
					<Button
						variant={editor.isActive("bold") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<TextBIcon size={16} />}
						onClick={() => editor.chain().focus().toggleBold().run()}
						aria-label="粗体"
					/>
				</Tooltip>
				<Tooltip content="斜体" side="bottom" asChild>
					<Button
						variant={editor.isActive("italic") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<TextItalicIcon size={16} />}
						onClick={() => editor.chain().focus().toggleItalic().run()}
						aria-label="斜体"
					/>
				</Tooltip>
				<Tooltip content="下划线" side="bottom" asChild>
					<Button
						variant={editor.isActive("underline") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<TextUnderlineIcon size={16} />}
						onClick={() => editor.chain().focus().toggleUnderline().run()}
						aria-label="下划线"
					/>
				</Tooltip>
				<Tooltip content="删除线" side="bottom" asChild>
					<Button
						variant={editor.isActive("strike") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<TextStrikethroughIcon size={16} />}
						onClick={() => editor.chain().focus().toggleStrike().run()}
						aria-label="删除线"
					/>
				</Tooltip>

				<div className="mx-1 h-5 w-px bg-kumo-fill" />

				{/* Lists */}
				<Tooltip content="项目符号列表" side="bottom" asChild>
					<Button
						variant={editor.isActive("bulletList") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<ListBulletsIcon size={16} />}
						onClick={() => editor.chain().focus().toggleBulletList().run()}
						aria-label="项目符号列表"
					/>
				</Tooltip>
				<Tooltip content="编号列表" side="bottom" asChild>
					<Button
						variant={editor.isActive("orderedList") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<ListNumbersIcon size={16} />}
						onClick={() => editor.chain().focus().toggleOrderedList().run()}
						aria-label="编号列表"
					/>
				</Tooltip>

				<div className="mx-1 h-5 w-px bg-kumo-fill" />

				{/* Block formatting */}
				<Tooltip content="引用" side="bottom" asChild>
					<Button
						variant={editor.isActive("blockquote") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<QuotesIcon size={16} />}
						onClick={() => editor.chain().focus().toggleBlockquote().run()}
						aria-label="引用"
					/>
				</Tooltip>
				<Tooltip content="链接" side="bottom" asChild>
					<Button
						variant={editor.isActive("link") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<LinkSimpleIcon size={16} />}
						onClick={setLink}
						aria-label="链接"
					/>
				</Tooltip>
				{editor.isActive("link") && (
					<Tooltip content="移除链接" side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<LinkBreakIcon size={16} />}
							onClick={() => editor.chain().focus().unsetLink().run()}
							aria-label="移除链接"
						/>
					</Tooltip>
				)}
				<Tooltip content="分隔线" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<MinusIcon size={16} />}
						onClick={() => editor.chain().focus().setHorizontalRule().run()}
						aria-label="分隔线"
					/>
				</Tooltip>

				<div className="mx-1 h-5 w-px bg-kumo-fill" />

				{/* Undo/Redo */}
				<Tooltip content="撤销" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<ArrowCounterClockwiseIcon size={16} />}
						onClick={() => editor.chain().focus().undo().run()}
						disabled={!editor.can().undo()}
						aria-label="撤销"
					/>
				</Tooltip>
				<Tooltip content="重做" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<ArrowClockwiseIcon size={16} />}
						onClick={() => editor.chain().focus().redo().run()}
						disabled={!editor.can().redo()}
						aria-label="重做"
					/>
				</Tooltip>
			</div>

			{/* Editor content */}
			<div className="flex-1 overflow-y-auto">
				<EditorContent editor={editor} />
			</div>
		</div>
	);
}
