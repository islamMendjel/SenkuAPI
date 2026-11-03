// POST /api/attachments/extract — read uploaded files for the
// composer. Multipart form data ("files" field, up to 5 files).
// Returns one record per readable file (what the model will be
// given) and one typed error per unreadable file — the client
// shows both, and unreadable files are never sent.
import { NextRequest, NextResponse } from "next/server";
import {
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_MAX_UPLOAD_BYTES,
  extractAttachment,
} from "@/lib/hermes/attachments";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart form data." },
      { status: 400 }
    );
  }

  const uploads = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!uploads.length) {
    return NextResponse.json({ error: "No files uploaded." }, { status: 400 });
  }
  if (uploads.length > ATTACHMENT_MAX_FILES) {
    return NextResponse.json(
      { error: `Up to ${ATTACHMENT_MAX_FILES} files per message.` },
      { status: 400 }
    );
  }

  const records: unknown[] = [];
  const errors: { name: string; error: string }[] = [];
  for (const file of uploads) {
    // Size gate before buffering anything.
    if (file.size > ATTACHMENT_MAX_UPLOAD_BYTES) {
      errors.push({
        name: file.name,
        error: `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 10 MB.`,
      });
      continue;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const outcome = await extractAttachment({
      name: file.name,
      mime: file.type,
      bytes,
    });
    if (outcome.ok) {
      records.push(outcome.record);
    } else {
      errors.push({ name: outcome.name, error: outcome.error });
    }
  }

  return NextResponse.json({ records, errors });
}
