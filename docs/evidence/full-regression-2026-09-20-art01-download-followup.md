# Full regression ART-01 download and immutability follow-up (2026-09-20)

## Browser artifact creation

- A fresh administrator conversation used the real `write`, `read`, and
  `submit_artifact` tools to create `art-01-probe-20260920.md` with the exact
  bytes `ART01_DOWNLOAD_ORACLE_20260920` plus a newline.
- The Run succeeded after three tool calls and returned
  `ART01_DOWNLOAD_SUBMITTED_20260920`. The UI showed one 31 B deliverable and
  its artifact-download link.

## Download and immutable snapshot check

- The deliverable link was activated through the browser UI while a download
  event was captured. The resulting local file was 31 B with SHA-256
  `777857aa2b73b37a67e13e294651fca147ded19a5a87b413e903cee8b1a3140b` and
  contained exactly `ART01_DOWNLOAD_ORACLE_20260920\n`.
- A same-conversation follow-up then overwrote the sandbox source file with
  `MUTATED_SOURCE_20260920\n` and explicitly did not call
  `submit_artifact`. It returned
  `ART01_SOURCE_MUTATED_NOT_RESUBMITTED_20260920`.
- Activating the original artifact link again produced another 31 B download
  with the same SHA-256 and original bytes, proving the submitted snapshot did
  not follow the later source-file mutation.

## Sandbox restart branch

- The `sandbox` service was restarted with `docker compose restart sandbox` and
  returned healthy before the next browser check.
- Jev reloaded the existing conversation. Its original messages, terminal Runs,
  source-mutation follow-up, and one 31 B deliverable were still projected.
- Activating the same original link after the restart produced a third 31 B
  download with the same SHA-256 and original bytes.

## Result impact

This strengthens ART-01 with real browser download bytes, hash verification,
source-mutation immutability, and post-sandbox-restart retrieval. ART-03 now
has a real restart/download branch as well, but remains `PARTIAL` because
cross-session import and the complete office-format snapshot matrix are not
closed.
