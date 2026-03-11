import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";

export interface ComposerImageAttachment {
  readonly type: "image";
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly previewUrl: string;
  readonly file: File;
}

export const IMAGE_ATTACHMENT_SIZE_LIMIT_LABEL = `${Math.round(
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024),
)}MB`;

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

export function createComposerImageAttachment(file: File): ComposerImageAttachment {
  return {
    type: "image",
    id: crypto.randomUUID(),
    name: file.name || "image",
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: URL.createObjectURL(file),
    file,
  };
}

export function composerImageDedupKey(image: {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}) {
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}`;
}

export function revokeComposerImageAttachmentPreview(attachment: {
  readonly previewUrl: string;
}) {
  if (attachment.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

export async function toUploadImageAttachment(
  attachment: ComposerImageAttachment,
): Promise<UploadChatImageAttachment> {
  return {
    type: "image",
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    dataUrl: await readFileAsDataUrl(attachment.file),
  };
}

export {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
};
