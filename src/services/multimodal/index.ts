// Senku Multimodal & Forge Service (Microservice Domain Entrypoint)
// Cloud image generator, sandboxed code execution, and file extraction.

import { forgeImage, imageFilePath, discardImageFile } from "@/lib/hermes/imagegen";
import { extractAttachment, type ExtractOutcome } from "@/lib/hermes/attachments";
import { buildRunnerDoc, isRunnableJs, RUNNER_TIMEOUT_MS } from "@/lib/hermes/js-runner";
import type { IMultimodalService, AttachmentInputData } from "./types";
import type { ImageRef, ImageSize } from "@/lib/hermes/types";

export * from "./types";
export {
  forgeImage,
  imageFilePath,
  discardImageFile,
  extractAttachment,
  buildRunnerDoc,
  isRunnableJs,
  RUNNER_TIMEOUT_MS,
  type ExtractOutcome,
  type AttachmentInputData,
};

class MultimodalServiceImpl implements IMultimodalService {
  async forgeImage(prompt: string, size: ImageSize): Promise<ImageRef> {
    return forgeImage(prompt, size);
  }

  async extractAttachment(input: AttachmentInputData): Promise<ExtractOutcome> {
    return extractAttachment({
      name: input.name,
      bytes: input.bytes,
      mime: input.mime || "application/octet-stream",
    });
  }

  buildSandboxHtml(code: string): string {
    return buildRunnerDoc(code);
  }
}

export const multimodalService = new MultimodalServiceImpl();
