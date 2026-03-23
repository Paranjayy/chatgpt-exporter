chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'CREATE_ZIP_BLOB') return;

  (async () => {
    try {
      const zip = new JSZip();
      
      for (const f of msg.files) {
        // Files sent from standard background as Base64 strings.
        zip.file(f.name.replace(/\\/g, '/'), f.dataB64, { base64: true });
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
