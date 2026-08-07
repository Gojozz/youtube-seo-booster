YOUTUBE SEO BOOSTER V2.1 — CACHE + RATE LIMIT

Yang ditambahkan:
- Cloudflare KV cache untuk hasil search dan video.
- Search cache 30 menit.
- Video cache 10 menit.
- Stale cache sampai 2 jam + refresh background.
- Normalisasi keyword agar variasi spasi tidak membuat cache baru.
- Rate limit sederhana 20 request API-backed/IP/menit.
- API key tetap sebagai Worker Secret.
- Cache HIT tidak memanggil YouTube API.

SETUP:

1. Buat KV namespace:
   npx wrangler kv namespace create CACHE

2. Ambil ID yang diberikan Wrangler, lalu ganti:
   GANTI_DENGAN_KV_NAMESPACE_ID
   di wrangler.toml.

3. Pasang API key:
   npx wrangler secret put YOUTUBE_API_KEY

4. Deploy:
   npx wrangler deploy

Catatan:
- Rate limit di sini sengaja sederhana dan memakai KV. Untuk traffic besar, tahap berikutnya bisa memakai Durable Objects atau rate limiting bawaan Cloudflare.
- Cache membantu menghemat quota, tetapi tidak menghilangkan quota cost untuk cache MISS.
