const fs = require('node:fs');
const path = require('node:path');

const CONTENT_MODULE_FILES = [
    'content-common.js',
    'content-indicator.js',
    'content-reading.js',
    'content-notice.js',
    'content-ocr.js',
    'content-entry.js'
];

function readContentSource() {
    const root = path.join(__dirname, '..');
    return CONTENT_MODULE_FILES
        .map((file) => fs.readFileSync(path.join(root, file), 'utf8'))
        .join('\n;\n');
}

module.exports = { CONTENT_MODULE_FILES, readContentSource };
