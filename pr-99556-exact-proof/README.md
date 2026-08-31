# PR #99556 exact-head proof

- PR head: `56347bbdf88020dbda839be75188932acb45f864`
- Proof harness: `88d283e3e18a12b2b10b490d334ff7c37f6279ac`
- GitHub Actions run: https://github.com/ly85206559/openclaw/actions/runs/33400184316
- Job: https://github.com/ly85206559/openclaw/actions/runs/33400184316/job/99514310267

The Gateway record proves that inline image data is omitted from both
`chat.history` pending content and `chat.message.get`, including leading-space
data URLs and `source.url` / `source.data`, while an HTTPS image reference is
preserved. The browser recording proves that history renders the omission card
without restoring an image and that a later live image still renders.

Files:

- `pending-gateway-evidence.json`: serialized Gateway responses and assertions.
- `evidence.json`: browser assertion counts and exact PR head.
- `01-nested-history-omitted.png`: history omission state.
- `02-live-image-preserved.png`: live image still renders after history load.
- `page@23325b2149e0cb44d334a93fdf06a5b8.webm`: complete browser recording.
