#!/usr/bin/env node
// Local preview of ./docs with the CORS header Stremio needs.
//   node serve.js   →  page: http://127.0.0.1:7000/   addon: http://127.0.0.1:7000/manifest.json

const http = require("http");
const fs = require("fs");
const path = require("path");

const DOCS = path.join(__dirname, "docs");
const PORT = process.env.PORT || 7000;
const TYPES = { ".jpg": "image/jpeg", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".html": "text/html; charset=utf-8" };

http
  .createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    let file;
    try {
      let rel = decodeURIComponent(req.url.split("?")[0]);
      if (rel.includes("\0")) throw new Error("Invalid path");
      if (rel.endsWith("/")) rel += "index.html";
      file = path.normalize(path.join(DOCS, rel));
      const within = (root, target) => target.startsWith(root + path.sep);
      for (let segment = file; segment !== DOCS; segment = path.dirname(segment)) {
        if (!within(DOCS, segment) || fs.lstatSync(segment).isSymbolicLink()) throw new Error("Symlink in preview");
      }
      if (!within(DOCS, file) || !fs.existsSync(file) || fs.statSync(file).isDirectory() ||
          !within(fs.realpathSync(DOCS), fs.realpathSync(file))) throw new Error("Outside preview");
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end('{"err":"not found"}');
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Mood Engine → http://127.0.0.1:${PORT}/  (addon: /manifest.json)`));
