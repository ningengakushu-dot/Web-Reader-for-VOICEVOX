# Package size report

- ZIP: `web-reader-for-voicevox-1.4.3.zip`
- Compressed payload: **28.07 MiB**
- Uncompressed payload: **36.17 MiB**

## Largest packaged files

| File | Compressed | Uncompressed |
|---|---:|---:|
| `vendor/tesseract/lang/jpn_vert.traineddata` | 12.37 MiB | 13.67 MiB |
| `vendor/tesseract/lang/jpn.traineddata` | 12.37 MiB | 13.67 MiB |
| `vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js` | 1.42 MiB | 3.77 MiB |
| `vendor/tesseract/core/tesseract-core-lstm.wasm.js` | 1.42 MiB | 3.77 MiB |
| `ocr-words.txt` | 0.35 MiB | 0.78 MiB |
| `vendor/tesseract/worker.min.js` | 0.03 MiB | 0.11 MiB |
| `images/icon128.png` | 0.03 MiB | 0.03 MiB |
| `content.js` | 0.01 MiB | 0.05 MiB |
| `background.js` | 0.01 MiB | 0.04 MiB |
| `dom-text.js` | 0.01 MiB | 0.04 MiB |
| `ocr-common.js` | 0.01 MiB | 0.03 MiB |
| `vendor/tesseract/tesseract.min.js` | 0.01 MiB | 0.06 MiB |
| `ocr-refine.js` | 0.01 MiB | 0.02 MiB |
| `ocr-image.js` | 0.01 MiB | 0.02 MiB |
| `offscreen.js` | 0.01 MiB | 0.02 MiB |
| `images/icon48.png` | 0.01 MiB | 0.01 MiB |
| `options.js` | 0.01 MiB | 0.02 MiB |
| `capture.js` | 0.00 MiB | 0.01 MiB |
| `constants.js` | 0.00 MiB | 0.01 MiB |
| `LICENSE-APACHE-2.0` | 0.00 MiB | 0.01 MiB |
| `vendor/tesseract/LICENSE` | 0.00 MiB | 0.01 MiB |
| `images/icon32.png` | 0.00 MiB | 0.00 MiB |
| `options.css` | 0.00 MiB | 0.01 MiB |
| `options.html` | 0.00 MiB | 0.01 MiB |
| `background-security.js` | 0.00 MiB | 0.01 MiB |
| `images/icon16.png` | 0.00 MiB | 0.00 MiB |
| `capture.css` | 0.00 MiB | 0.00 MiB |
| `ocr-dictionary-NOTICE.md` | 0.00 MiB | 0.00 MiB |
| `offscreen-security.js` | 0.00 MiB | 0.00 MiB |

## Notes

- `vendor/tesseract/lang/*.traineddata` are OCR recognition models and directly affect recognition accuracy.
- Tesseract.js selects the WASM core according to runtime capabilities; core files are not removed without compatibility testing.
- Application JavaScript, CSS and icons are measured separately from the OCR assets above.
