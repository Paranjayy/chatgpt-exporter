chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'CREATE_ZIP_BLOB') return;

  (async () => {
    try {
      const zip = new JSZip();
      
      for (const f of msg.files) {
        const name = f.name.replace(/\\/g, '/');
        if (f.dataB64) {
          // Pre-encoded base64 content
          zip.file(name, f.dataB64, { base64: true });
        } else if ('content' in f) {
          // Raw string content (text files: md, json, html, csv)
          zip.file(name, f.content);
        } else if (f.url) {
          // Remote asset — fetch and embed (http/https only to prevent unsafe protocols)
          try {
            if (!/^https?:\/\//i.test(f.url)) throw new Error('Unsupported protocol');
            const resp = await fetch(f.url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const ab = await resp.arrayBuffer();
            zip.file(name, ab);
          } catch (e) {
            // Skip asset but don't fail entire ZIP
            console.warn(`Asset skipped (${name}): ${e.message}`);
          }
        }
      }
      
      const blob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: {
            level: 6
        }
      });
      
      const url = URL.createObjectURL(blob);
      
      // Hidden link approach: 100% reliable for any document context
      const a = document.createElement('a');
      a.href = url;
      a.download = msg.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      // Cleanup
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      sendResponse({ success: true });
    } catch (e) {
      sendResponse({ error: e.message });
    }
  })();
  
  return true;
});
