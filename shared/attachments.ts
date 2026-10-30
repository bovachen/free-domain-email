// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Which attachments readers list as files. An "inline" part with a Content-Id
// is usually an image the HTML body shows through a cid: link (a signature
// logo, a pasted screenshot), so listing it too would be noise. But iPhone
// Mail also marks photos in plain-text mail "inline"; no cid: link shows
// those, and hiding them left the photo nowhere to be seen.

interface AttachmentRef {
	content_id?: string | null;
	disposition?: string | null;
}

/** Whether the body shows this attachment itself, through a cid: link. */
export function isShownInBody(attachment: AttachmentRef, body: string): boolean {
	if (attachment.disposition !== "inline") return false;
	const cid = attachment.content_id?.replace(/^<|>$/g, "").toLowerCase();
	return Boolean(cid) && body.toLowerCase().includes(`cid:${cid}`);
}

/** The attachments to list as files: everything the body does not show. */
export function listedAttachments<T extends AttachmentRef>(attachments: T[] | undefined, body: string): T[] {
	return attachments?.filter((attachment) => !isShownInBody(attachment, body)) ?? [];
}
