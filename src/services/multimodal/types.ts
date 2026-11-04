// Senku Multimodal & Forge Service — Domain Contracts and Types.
// Zero-local-compute cloud image forge, sandboxed JavaScript runner,
// and attachment extraction engine.

import type { ImageRef, ImageSize } from "@/lib/hermes/types";
import type { ExtractOutcome } from "@/lib/hermes/attachments";

export interface AttachmentInputData {
  name: string;
  bytes: Uint8Array;
  mime?: string;
}

export interface IMultimodalService {
  forgeImage(prompt: string, size: ImageSize): Promise<ImageRef>;
  extractAttachment(input: AttachmentInputData): Promise<ExtractOutcome>;
  buildSandboxHtml(code: string): string;
}
