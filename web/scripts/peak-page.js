// Makes public/peak/index.html from public/index.html, so the Peak test page never drifts from the app page.
// The page lives at /peak/ but loads every shared file (icons, audio, heat motion) from the site root.
const fs = require("fs");
const path = require("path");
const pub = path.join(__dirname, "..", "public");
let html = fs.readFileSync(path.join(pub, "index.html"), "utf8");
const swap = (a, b) => { if (!html.includes(a)) throw new Error(`peak-page: can't find ${a}`); html = html.replace(a, b); };
swap("<head>", '<head>\n<base href="../">\n<meta name="robots" content="noindex">');
swap('<script src="app.js"></script>', '<script src="peak/app.js"></script>');
html = html.replace(/<title>([^<]*)<\/title>/, "<title>$1 (Peak test)</title>");
fs.mkdirSync(path.join(pub, "peak"), { recursive: true });
fs.writeFileSync(path.join(pub, "peak", "index.html"), html);
console.log("public/peak/index.html written");
