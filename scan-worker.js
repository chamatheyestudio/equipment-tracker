/* QR decoding off the main thread (used when the phone has no built in barcode reader, e.g. iPhone). */
importScripts('vendor/jsQR.js');
self.onmessage = function (e) {
  var m = e.data, code = null;
  try {
    var r = jsQR(new Uint8ClampedArray(m.data), m.w, m.h, { inversionAttempts: 'attemptBoth' });
    if (r && r.data) code = r.data;
  } catch (err) { /* ignore a bad frame */ }
  self.postMessage({ id: m.id, code: code });
};
