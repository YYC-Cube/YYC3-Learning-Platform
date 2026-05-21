const fs = require('fs');
let src = fs.readFileSync('next.config.js', 'utf8');

function replaceFn(src, fnName) {
  const patterns = ['async ' + fnName + '()', fnName + '()'];
  for (const pat of patterns) {
    const start = src.indexOf(pat);
    if (start === -1) continue;
    let braceCount = 0;
    let i = src.indexOf('{', start);
    if (i === -1) continue;
    braceCount = 1;
    i++;
    while (i < src.length && braceCount > 0) {
      if (src[i] === '{') braceCount++;
      else if (src[i] === '}') braceCount--;
      i++;
    }
    src = src.substring(0, start) + fnName + '() { return []; }' + src.substring(i);
    break;
  }
  return src;
}

src = replaceFn(src, 'rewrites');
src = replaceFn(src, 'redirects');
src = replaceFn(src, 'headers');
src = src.replace("output: 'standalone'", "output: 'export'");
src = src.replace(/unoptimized: process\.env\.NODE_ENV === 'development'/, 'unoptimized: true');
src = src.replace(/removeConsole: process\.env\.NODE_ENV === 'production'/, 'removeConsole: false');
fs.writeFileSync('next.config.js', src);
console.log('Patched for static export');
