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
      if (!res || res.status === 0) return res;
      var orig = (res.headers.get('content-type') || '').toLowerCase();
      var ct = orig.indexOf('mpegurl') !== -1 ? 'application/vnd.apple.mpegurl' : 'video/mp4';
      var h = new Headers();
      res.headers.forEach(function(v, k) {
        if (k.toLowerCase() !== 'content-type' && k.toLowerCase() !== 'content-length') h.append(k, v);
      });
      h.set('Content-Type', ct);
      h.set('Access-Control-Allow-Origin', '*');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }).catch(function() {
      return fetch(e.request.url, { mode: 'no-cors', credentials: 'omit' });
    })
  );
});