# Agent Vision (image input)

## Goal

When a Model Registry entry declares `input_modalities: ["text", "image"]`, the agent must actually receive image pixels — not only path metadata.

## Acceptance criteria

1. **Current-turn image attachments** on a vision-capable model are downloaded from the sandbox workspace, resized/normalized, and passed to `session.prompt(text, { images })`.
2. **Enterprise `read` tool** returns `{ type: "image", data, mimeType }` for image files when the model supports vision; text-only models get a clear note that the image was omitted.
3. Non-image attachments remain path-based (`read` for text/binary workflows).
4. Registry models without `image` do not attempt vision inline.
5. Unit tests cover modality gate, mime detection, load path, and prompt wording.

## Out of scope

- Image *generation* / output modalities
- Frontend-only preview changes
- Changing product size limits beyond provider resize helpers
