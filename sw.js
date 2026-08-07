/* Service Worker — 离线缓存门户核心资源 */
var CACHE_NAME = 'lafloraison-portal-v1';

var PRECACHE = [
  '.',
  'index.html',
  'manifest.json',
  'reader/roadofcs/index.html',
  'reader/math5all/index.html'
  /* Note: marked.js is loaded from CDN and cached on first use */
];

self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(PRECACHE).catch(function(err){
        /* Continue even if some pre-cache items fail */
        console.log('SW precache partial:', err);
      });
    }).then(function(){
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(k){return k!==CACHE_NAME}).map(function(k){return caches.delete(k)})
      );
    }).then(function(){
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(e){
  /* Only handle GET */
  if(e.request.method!=='GET')return;

  /* For navigation requests, serve index.html (SPA-like fallback) */
  /* For other requests: cache-first, falling back to network */
  e.respondWith(
    caches.match(e.request).then(function(cached){
      if(cached)return cached;
      return fetch(e.request).then(function(response){
        /* Cache successful GET responses */
        if(response&&response.status===200&&response.type==='basic'){
          var clone=response.clone();
          caches.open(CACHE_NAME).then(function(cache){cache.put(e.request,clone)});
        }
        return response;
      }).catch(function(){
        /* Offline fallback */
        if(e.request.mode==='navigate'){
          return caches.match('index.html');
        }
        return new Response('Offline',{status:503});
      });
    })
  );
});
