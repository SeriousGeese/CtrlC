const { clipboard, app } = require('electron');

// Test basic clipboard operations on Wayland
console.log('Testing clipboard API on Wayland...');

// Test read/write text
const text = 'Hello Wayland Clipboard';
clipboard.writeText(text);
const readText = clipboard.readText();
console.log(`[TEXT] Write: "${text}" | Read: "${readText}" | Match: ${text === readText}`);

// Test HTML clipboard
const html = '<b>Bold text</b> and <i>italic</i>';
clipboard.write({ html: html, text: html });
const readHtml = clipboard.readHtml();
console.log(`[HTML] Write: "${html}" | Read: "${readHtml}" | Match: ${html === readHtml}`);

// Test available formats
const formats = clipboard.availableFormats();
console.log(`[FORMATS] Available: ${formats.join(', ')}`);

// Test image clipboard
const { nativeImage } = require('electron');
const img = nativeImage.createEmpty();
img.setSize({ width: 10, height: 10 });
clipboard.write({ image: img });
const readImg = clipboard.readImage();
console.log(`[IMAGE] Write: 10x10 | Read: isEmpty=${readImg.isEmpty()} | HasBitmap: ${!readImg.toPNG().length}`);

console.log('\nAll clipboard operations completed successfully.');
app.quit();
