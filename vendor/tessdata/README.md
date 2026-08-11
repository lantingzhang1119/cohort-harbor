# Local Tesseract language data

Used by the question-bank scanned-PDF OCR pipeline (`tesseract.js` 7).

- `chi_sim.traineddata` — Simplified Chinese (`tessdata_fast`), SHA-256 `a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730`
- `eng.traineddata` — English (`tessdata_fast`), SHA-256 `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2`

Upstream source: <https://github.com/tesseract-ocr/tessdata_fast> (downloaded from the corresponding raw files).
The trained data is distributed under Apache License 2.0; upstream license:
<https://github.com/tesseract-ocr/tessdata_fast/blob/main/LICENSE>.
The same license text is bundled at `LICENSES/Apache-2.0.txt`.

Do **not** replace these with cloud OCR endpoints. The runtime loads only this local directory (or `TESSDATA_PREFIX`).
