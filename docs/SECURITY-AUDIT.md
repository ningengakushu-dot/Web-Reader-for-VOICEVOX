# Security and reliability audit — v1.4.2

## Scope

The review covered the Manifest V3 configuration, service worker, content scripts, extension pages,
message boundaries, local VOICEVOX communication, OCR processing, storage, release packaging,
GitHub Actions, and vendored Tesseract assets.

The review combines source inspection, purpose-built static checks, execution of the actual scripts in
Node VM test harnesses, and GitHub CodeQL. It does not prove that no defect exists; browser-level
manual regression testing remains required before publishing.

## Trust boundaries

- Web page content is untrusted. It must not control extension messages or inject markup into extension UI.
- Messages are accepted only from this extension and are validated again at the background/offscreen boundary.
- The process listening on `127.0.0.1:50021` is expected to be VOICEVOX, but responses are treated as
  potentially malformed, oversized, or stalled.
- Screenshots, selected text, OCR output, and custom icons are bounded and retained only as needed.

## Findings remediated

- Prevented stale content scripts from producing uncaught `Extension context invalidated` errors after updates.
- Reinjects the complete content-script stack on update and removes stale listeners/UI during replacement.
- Rejects password-field selections so credentials are never sent to the speech pipeline.
- Added sender, message-type, payload-size, numeric-range, frame, and extension-page validation.
- Fixed capture-page message authorization when its URL contains the `cid` query parameter.
- Bounded and timed the complete VOICEVOX response body, not only the initial HTTP response.
- Normalized speaker metadata and limited icon payloads returned by the local engine.
- Sanitized restored icon data and settings before using them in CSS or the UI.
- Limited uploaded image dimensions and re-encodes accepted images as PNG.
- Serialized cross-tab voice operations and bounded pending OCR work to prevent race conditions and queue growth.
- Prevented playback errors from being immediately overwritten by a normal completion event.
- Added limits for unusually long synthesis chunks and captured-image data.
- Added expiry and failure cleanup for session-stored screenshots.
- Prevented the feature announcement from repeating on every patch update.
- Pinned GitHub Actions to immutable commit SHAs and recorded SHA-256 hashes for vendored OCR assets.
- Added release-package and static security checks to CI.

## Review notes

Tesseract's `Parameter not found` messages originate from compatibility settings embedded in the Japanese
language data and do not stop OCR. They are not hidden by the extension. Updating Tesseract.js and its language
data is intentionally handled as a separate compatibility/accuracy change because it can materially alter OCR
results and package size.

## Required release checks

1. All GitHub Actions and CodeQL checks pass.
2. Load the unpacked extension and test text reading, stop/interrupt, shortcut, context menu, OCR, options,
   custom icons, multi-tab use, and extension update/reload behavior.
3. Build the Web Store ZIP with `tools/pack.ps1` and verify that no development-only files are included.
