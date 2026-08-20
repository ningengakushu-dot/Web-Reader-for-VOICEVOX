// Install message-boundary validation before the main service worker starts.
importScripts("validation-utils.js");
importScripts("background-security.js");
// Keep the historical load order: constants were the first statement of background.js.
importScripts("constants.js");
// Runtime code is split by responsibility; background.js remains a compatibility bundle for tests.
importScripts("background-bootstrap.js");
// Dynamic reinjection follows manifest.content_scripts exactly; this tiny production-only configuration
// is kept outside the compatibility bundle because legacy VM tests do not exercise script injection.
importScripts("background-content-scripts.js");
importScripts("background-playback.js");
importScripts("background-runtime.js");
importScripts("background-speech.js");
