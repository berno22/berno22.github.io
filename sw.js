'use strict';
var STREAM_HOSTS = ['opalescentoblivion.space', 'opalescentoblivion.com', 'opalescentoblivion.net'];

self.addEventListener('install', function(e) { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function(e) {
  var host = '';
  try { host = new URL(e.request.url).hostname; } catch (err) {}
  if (STREAM_HOSTS.indexOf(host) === -1) return;

  e.respondWith(
    fetch(e.request.url, { mode: 'cors', credentials: 'omit' }).then(function(res) {
      console.log('SW cors:', e.request.url.slice(0, 60), res.status);
      if (!res.ok) return fetch(e.request.url, { mode: 'no-cors', credentials: 'omit' }).then(function(r2) {
        console.log('SW fallback:', e.request.url.slice(0, 60), r2.status, r2.type);
        return r2;
      });
      return res.arrayBuffer().then(function(buf) {
        var isPlaylist = buf.byteLength > 0 && new Uint8Array(buf, 0, 1)[0] === 0x23;
        var h = new Headers();
        res.headers.forEach(function(v, k) {
          if (k.toLowerCase() !== 'content-type' && k.toLowerCase() !== 'content-length') h.append(k, v);
        });
        h.set('Content-Type', isPlaylist ? 'application/vnd.apple.mpegurl' : 'video/mp4');
        h.set('Access-Control-Allow-Origin', '*');
        console.log('SW rewrite:', e.request.url.slice(0, 60), isPlaylist ? 'm3u8' : 'mp4');
        return new Response(new Uint8Array(buf), { status: res.status, statusText: res.statusText, headers: h });
      });
    }).catch(function(err) {
      console.log('SW catch:', e.request.url.slice(0, 60), String(err));
      return fetch(e.request.url, { mode: 'no-cors', credentials: 'omit' });
    })
  );
});