# Diskbuddy Mirror

Reverse proxy Node.js untuk Railway, Render, Docker, atau VPS. Semua path dan query diteruskan ke satu upstream tetap. HTML, header URL, CSS, JSON, robots, dan sitemap dipetakan ke domain publik; aset biner di-stream. Tidak memerlukan Cloudflare Workers.

**Gunakan hanya untuk website milik Anda atau yang Anda punya izin untuk mirror. Full mirror tetap memiliki konten duplikat. Script ini memperbaiki sinyal teknis, bukan menjamin indeks atau membuat konten menjadi unik.**

## Temuan Pada Sumber

Pemeriksaan 8 September 2026:

- `https://diskbuddy.com/` dan `/robots.txt` mengirim 308 ke host `www`.
- `https://www.diskbuddy.com/` memberi 200; HTML awal yang diperiksa tidak memiliki canonical maupun JSON-LD.
- `https://www.diskbuddy.com/robots.txt` memberi 404.

Karena itu contoh memakai `https://www.diskbuddy.com` sebagai upstream dan domain tanpa `www` sebagai alias. Temuan ini bukan audit seluruh situs atau data akun Search Console Anda, dan bisa berubah.

## Menjalankan Lokal

Butuh Node.js 22.12+ dan npm.

```bash
npm ci
cp .env.example .env
npm start
```

Buka `http://localhost:3000`. Tes: `npm test`. Pemeriksaan syntax dan tes: `npm run check`.

`PUBLIC_URL` berisi origin final, tanpa path, query, atau kredensial. Di Railway, jika kosong, aplikasi memakai `https://` + `RAILWAY_PUBLIC_DOMAIN` yang diberikan platform. Di luar Railway, `PUBLIC_URL` tetap wajib. Jangan gunakan domain yang sama dengan upstream. `.env` tidak masuk Git atau image Docker.

## Konfigurasi

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `UPSTREAM_URL` | `https://www.diskbuddy.com` | Origin sumber final, bukan host yang selalu redirect ke alias. |
| `UPSTREAM_ALIASES` | Apex Diskbuddy jika upstream tidak diisi | Origin tambahan dipisah koma, misalnya `https://diskbuddy.com`. Untuk upstream kustom, isi aliasnya secara eksplisit. Alias untuk rewrite; koneksi tetap ke upstream utama. |
| `PUBLIC_URL` | Domain publik Railway jika tersedia; selain itu wajib | Domain final mirror, misalnya `https://mirror.example`. Nilai eksplisit selalu diprioritaskan. |
| `PORT`, `HOST` | `3000`, `0.0.0.0` | Memakai `PORT` dari platform. |
| `INDEXABLE` | `false` | Menambahkan `noindex` selama staging. Ubah `true` setelah siap. Tidak menghapus `noindex` dari sumber. |
| `CANONICAL_MODE` | `mirror` | `mirror`: petakan canonical sumber; `upstream`: pertahankan canonical ke sumber. |
| `TRUST_PROXY` | `true` di Railway, selain itu `false` | Railway dideteksi melalui `RAILWAY_PROJECT_ID` atau `RAILWAY_PUBLIC_DOMAIN`. Render/Caddy HTTPS: isi `true`. Override eksplisit tetap dipakai. |
| `ENFORCE_PUBLIC_ORIGIN` | `true` | Host/skema lain diarahkan 308 ke `PUBLIC_URL`. |
| `SITEMAP_PATHS` | Kosong | Sitemap sumber tambahan, dipisah koma: `/sitemap_index.xml,/news.xml`. Ini path sitemap, bukan halaman biasa. |
| `SITEMAP_PAGE_PATHS` | Kosong | Daftar halaman eksplisit untuk fallback jika sumber tidak menyediakan sitemap, misalnya `/,/about`. Maksimal 500; bukan crawler otomatis. |
| `SANITIZE_JSONLD` | `true` | Normalisasi Breadcrumb yang cukup datanya; hapus blok JSON-LD yang gagal parse dan Breadcrumb yang tidak valid, disertai log. |
| `REWRITE_SCRIPTS` | `false` | Opsional: rewrite URL literal dalam JavaScript inline/bundle. Harus diuji terhadap aplikasi sumber. |
| `UPSTREAM_TIMEOUT_MS` | `30000` | Timeout request/stream dan batas waktu discovery sitemap. |
| `MAX_TRANSFORM_BYTES` | `16777216` | Batas buffer HTML/XML/CSS/JSON/JS yang diubah, termasuk hasil gunzip. Kelebihan memberi 502, bukan dokumen terpotong. |
| `MAX_REQUEST_BYTES` | `16777216` | Batas upload/request body; kelebihan memberi 413. |

Nilai boolean hanya `true` atau `false`. Proxy tidak memakai Host dari pengunjung untuk membuat canonical. Aktifkan `TRUST_PROXY` hanya di belakang reverse proxy terpercaya; pada VPS jangan buka port aplikasi langsung ke internet. Proxy harus meneruskan Host publik dan menimpa `X-Forwarded-Proto` dengan skema koneksi sebenarnya.

## Sitemap Dan Robots

1. `/robots.txt` mempertahankan aturan crawl sumber. Semua deklarasi sitemap dari origin/alias yang dikenal dipetakan ke domain mirror. Deklarasi eksternal tidak di-fetch; tambahkan alias hanya jika memang bagian dari sumber yang Anda kelola.
2. Jika tidak ada deklarasi, discovery memeriksa `/sitemap.xml`, `/sitemap_index.xml`, dan `/wp-sitemap.xml`. `SITEMAP_PATHS` dapat menentukan lokasi sumber yang lain.
3. Semua path XML diteruskan. URL di sitemap index, child sitemap, `.xml.gz`, image/video sitemap, dan hreflang dipetakan. Namespace, `lastmod`, dan struktur dipertahankan; XML tidak diproses dengan penggantian teks buta.
4. Jika `/sitemap.xml` sumber 404 tetapi ada sitemap lain yang ditemukan, mirror menyediakan sitemap index yang menunjuk ke sitemap tersebut. Child sitemap tetap diambil saat diminta, bukan digabung menjadi daftar beranda saja.
5. Jika tidak ada sitemap dan `SITEMAP_PAGE_PATHS` diisi, setiap halaman eksplisit diverifikasi. Hanya HTML 200 yang diizinkan robots, tanpa `noindex`, dengan canonical sesuai URL final, yang masuk fallback `urlset`. Redirect diselesaikan hanya di upstream lokal; sitemap berisi URL final. Tanggal modifikasi tidak dikarang.
6. Jika tidak ada sitemap maupun halaman fallback yang valid, `/sitemap.xml` tetap 404 dan log memuat `sitemap_not_found`. Tidak ada klaim sitemap lengkap dari daftar URL tebakan. Robots 404 dapat diganti robots valid tanpa tautan sitemap palsu.

Contoh **khusus bila homepage memang satu-satunya halaman publik**:

```dotenv
SITEMAP_PAGE_PATHS=/
```

Untuk situs multi-halaman, isi inventaris route publik yang lengkap atau, lebih baik, sediakan sitemap lengkap di sumber. Discovery bukan crawler seluruh situs. Sitemap yang dideklarasikan sumber dipercaya, bukan diaudit setiap URL-nya; jika sumber mencantumkan URL mati/noncanonical, perbaiki sitemap sumber. Daftar discovery di-cache 5 menit, kegagalan/kosong 15 detik; isi sitemap sumber sendiri tetap diambil saat diminta.

Batas standar sitemap adalah 50.000 URL dan 50 MB setelah dekompresi per file. Jika sitemap valid Anda lebih besar dari batas buffer default 16 MiB, naikkan `MAX_TRANSFORM_BYTES`, misalnya `67108864`, dan sediakan RAM cukup. Untuk situs besar, gunakan sitemap index dan pecah file di sumber.

## Perilaku SEO

- Canonical HTML dibuat tunggal. Canonical HTTP `Link` diprioritaskan supaya header dan HTML selaras. Canonical sumber yang menggabungkan varian URL tetap dipertahankan, lalu domainnya dipetakan. Canonical eksternal yang disengaja tidak dipaksa menjadi self-canonical.
- Jika canonical tidak tersedia, gunakan URL halaman, tanpa fragment dan parameter tracking umum seperti `utm_*`, `gclid`, dan `fbclid`. Query pencarian, pagination, filter, dan trailing slash tidak diseragamkan sembarangan.
- `og:url`, `twitter:url`, hreflang, base URL, link, form action, srcset, URL data JSON, CSS, Location, Refresh, dan URL CSP yang dikenali ikut dipetakan. Link eksternal tetap eksternal.
- JSON-LD di-parse dan diserialisasi kembali. Breadcrumb yang memiliki nama dan item memadai diberi posisi berurutan mulai 1. Blok rusak atau Breadcrumb tanpa data wajib dihapus dan dicatat, bukan diganti kategori fiktif. Schema lain tetap dipertahankan; ini bukan validator lengkap seluruh schema.org atau syarat rich result Google.
- Status 404/410/5xx tetap benar. Redirect 301/302/303/307/308 tidak diikuti secara diam-diam untuk request pengguna. Redirect sumber yang menjadi loop setelah mapping memberi 502 dan petunjuk konfigurasi di log.
- Larangan indeks dan aturan crawl sumber tidak dibuang. `INDEXABLE=true` hanya mematikan noindex staging milik proxy, bukan memaksa semua halaman sumber boleh diindeks.
- Konten diproses sama untuk pengunjung dan crawler, tanpa cloaking atau penyamaran 404 sebagai 200.

`SANITIZE_JSONLD=false` mempertahankan JSON-LD rusak untuk debugging. Menghapus schema invalid dapat menghilangkan error parse, tetapi **tidak otomatis menghasilkan Breadcrumb rich result**. Error Breadcrumb dalam microdata/RDFa, schema yang dibuat setelah JavaScript berjalan, dan data yang tidak lengkap tetap perlu diperbaiki di sumber.

## Deployment

### Railway

Hubungkan repo sebagai service. [railway.json](railway.json) memakai [Dockerfile](Dockerfile) dan health check `/healthz`.

Set Variables:

```dotenv
PUBLIC_URL=https://domain-final-anda.example
UPSTREAM_URL=https://www.diskbuddy.com
UPSTREAM_ALIASES=https://diskbuddy.com
TRUST_PROXY=true
INDEXABLE=false
CANONICAL_MODE=mirror
```

Gunakan domain Railway yang diberikan atau custom domain HTTPS sebagai `PUBLIC_URL`. Jika `PUBLIC_URL` tidak diisi, aplikasi memakai `RAILWAY_PUBLIC_DOMAIN` otomatis dengan HTTPS. Aktifkan public domain di Settings > Networking agar variabel tersebut tersedia; untuk custom domain, tetap isi `PUBLIC_URL` secara eksplisit. Tidak perlu memaksa `PORT`; platform akan memasoknya. Isi konfigurasi sitemap sesuai sumber. Setelah validasi produksi selesai, ubah `INDEXABLE=true` bila domain mirror memang yang ingin diindeks.

Jika build sukses tetapi health check gagal:

1. Buka **Deploy Logs**, bukan hanya Build Logs. Versi lama berhenti sebelum membuka port jika `PUBLIC_URL` kosong. Versi ini mendukung fallback domain Railway, tetapi tetap memerlukan `PUBLIC_URL` bila platform belum menyediakan domain publik.
2. Untuk deployment Diskbuddy ini, konfigurasi eksplisit yang bisa dipakai adalah:

	```dotenv
	PUBLIC_URL=https://diskbuddy-mirror-production.up.railway.app
	HOST=0.0.0.0
	TRUST_PROXY=true
	INDEXABLE=false
	```

3. Jangan mengimpor seluruh `.env.example` lokal tanpa penyesuaian. `PUBLIC_URL=http://localhost:3000`, `HOST=127.0.0.1`, atau `TRUST_PROXY=false` tidak cocok untuk service publik di belakang HTTPS Railway. Nilai eksplisit tidak diganti otomatis.
4. Pakai health check `/healthz`, kosongkan Start Command override agar CMD Docker dipakai, dan pastikan target port pada Networking cocok dengan `PORT` runtime. Aplikasi bind ke `0.0.0.0` secara default. Log startup yang diharapkan adalah JSON dengan `event: listening` dan port aktual.
5. Deploy ulang setelah perubahan Variables/kode. Health check menerima host khusus Railway dan tidak mengakses upstream, sehingga menambah timeout health check tidak memperbaiki proses yang gagal startup. Respons publik `Application not found` dengan header `x-railway-fallback` berasal dari routing Railway, bukan handler aplikasi.

Jika masih gagal, periksa baris pertama error pada Deploy Logs untuk membedakan konfigurasi invalid, crash proses, port yang tidak cocok, atau masalah routing domain.

### Render

Buat Blueprint dari [render.yaml](render.yaml), lalu isi `PUBLIC_URL` dengan custom domain atau domain `onrender.com` final. Atau buat Web Service dengan runtime Docker. Health check `/healthz`, `TRUST_PROXY=true`, dan tidak ada build frontend.

Gunakan service yang selalu aktif untuk produksi yang perlu rutin di-crawl. Sleep/cold start, timeout upstream, atau resource yang terlalu kecil dapat menghambat crawling. File deployment disediakan, tetapi repo ini tidak otomatis membuat akun, domain, atau service berbayar.

### VPS Dengan Docker

Siapkan Docker Compose, Caddy, DNS domain ke VPS, dan port 80/443. Pada `.env`, isi domain HTTPS final, `TRUST_PROXY=true`, dan konfigurasi sitemap.

```bash
docker compose up -d --build
docker compose logs --tail=100 mirror
```

[compose.yaml](compose.yaml) hanya membuka aplikasi di `127.0.0.1:3000`. Gunakan [deploy/Caddyfile](deploy/Caddyfile), ganti `mirror.example` dengan domain Anda, lalu pasang sebagai konfigurasi Caddy. Caddy mengurus HTTPS dan forwarding header. Jangan jalankan Compose dan service systemd pada port yang sama.

### VPS Tanpa Docker

Pasang Node.js 22.12+, taruh project di `/opt/diskbuddy`, jalankan `npm ci --omit=dev`, siapkan `.env`, dan buat user sistem `diskbuddy` dengan akses baca project. Set `HOST=127.0.0.1` jika Caddy berada di mesin yang sama. Sesuaikan path Node pada [deploy/diskbuddy.service](deploy/diskbuddy.service) dengan hasil `command -v node`.

Pasang unit tersebut melalui administrator, lalu jalankan:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now diskbuddy
sudo systemctl status diskbuddy
journalctl -u diskbuddy -n 100 --no-pager
```

Gunakan Caddy seperti pada deployment Docker. `/healthz` memeriksa proses aplikasi, bukan ketersediaan seluruh upstream. SIGTERM/SIGINT menghentikan server secara graceful dengan batas 10 detik.

## Checklist Search Console

1. Tentukan satu domain utama. Jika ini hanya replika/cadangan, gunakan `CANONICAL_MODE=upstream` atau tetap `INDEXABLE=false`; jangan berharap mirror ikut terindeks sebagai situs unik. Jika ini migrasi resmi, atur 301 dari situs lama ke domain baru dan proses migrasi Search Console. Proxy sendiri tidak dapat mengubah situs lama.
2. Setelah HTTPS, canonical, robots, dan sitemap benar, aktifkan `INDEXABLE=true` untuk situs yang akan diindeks. Jangan men-submit domain staging atau mirror noncanonical. Mengubah canonical sendiri tidak menjamin pilihan Google, terutama bila kontennya sama dan sumber tetap aktif.
3. Verifikasi kepemilikan domain lewat DNS TXT. File verifikasi HTTP yang tidak ada di sumber tidak otomatis tersedia pada proxy.
4. Cek `/robots.txt`, root sitemap, setiap child sitemap, serta beberapa URL halaman. URL sitemap harus 200, indexable, tidak redirect, dan sesuai canonical. Halaman error sungguhan harus tetap 404/410.
5. Jalankan Rich Results Test dan URL Inspection **live test**, termasuk rendered HTML. Periksa user-declared canonical, Google-selected canonical, robots, dan schema. Pengujian lokal tidak dapat mewakili keputusan Google.
6. Submit sitemap yang valid dan tunggu recrawl. `Halaman dengan pengalihan` normal untuk URL lama yang sengaja redirect. `Duplikat, Google memilih versi kanonis berbeda` tidak selalu bug proxy; konten identik, backlink, internal linking, sitemap sumber, dan sinyal domain lain juga berpengaruh.

Pemeriksaan HTTP awal:

```bash
curl -I https://domain-final-anda.example/
curl -fsS https://domain-final-anda.example/robots.txt
curl -fsS https://domain-final-anda.example/sitemap.xml
curl -I https://domain-final-anda.example/url-yang-benar-benar-tidak-ada
```

Jangan membuat redirect massal semua 404 ke homepage atau mengubah error menjadi 200. Itu dapat menghasilkan soft 404 dan tidak memperbaiki indeks.

## Batasan Dan Operasional

- Ini reverse proxy, bukan salinan offline. Availability, kecepatan, konten, dan URL yang benar-benar tersedia bergantung pada sumber. Tidak membypass WAF, CAPTCHA, login, paywall, atau pembatasan akses sumber.
- JavaScript default diteruskan tanpa diubah. URL yang dibentuk runtime, string escaped di bundle, hydration/Next.js Flight, service worker, WebSocket, WebAuthn, OAuth callback, pembayaran, CAPTCHA, dan API lintas-domain bisa membutuhkan perubahan aplikasi sumber. WebSocket upgrade memberi 501. Uji alur tersebut sebelum mengklaim full mirror fungsional.
- `REWRITE_SCRIPTS=true` hanya mengganti URL literal yang dikenali, bukan parser/rekonstruksi seluruh aplikasi. Integritas SRI untuk resource yang mungkin berubah dilepas; CSP tidak dimatikan. Script yang memakai hash CSP atau signed payload dapat gagal dan perlu perbaikan sumber. Jangan mengaktifkannya tanpa pengujian browser.
- HTML/CSS/XML/JSON yang berubah tidak memakai ETag, Last-Modified, digest, atau Content-Length lama. Encoding HTTP yang didekompresi fetch dibuang. Teks memakai charset header jika ada, selain itu diasumsikan UTF-8; format legacy perlu diuji. Biner dan range pada ekstensi biner yang dikenali tetap di-stream.
- Tidak ada shared cache halaman/login. Request dengan cookie/Authorization atau respons Set-Cookie memakai `private, no-store`. Cookie Domain yang sesuai hostname sumber/alias menjadi host-only, atribut Secure/HttpOnly/SameSite tetap dipertahankan. Cookie parent-domain memerlukan parent tersebut pada alias yang Anda kelola. Untuk login produksi gunakan HTTPS.
- Discovery menggunakan request anonim dan hanya upstream tetap, tidak menerima URL tujuan bebas dari pengunjung atau sitemap eksternal. Log aplikasi mencatat jenis masalah, status, dan pathname, tanpa body, cookie, atau header Authorization.
- XML dengan DTD/entity atau dokumen invalid ditolak. JSON API yang tidak valid akan memberi error proxy, bukan dibenahi dengan tebakan. Batas ukuran berlaku per request; sesuaikan RAM dan rate limiting di reverse proxy untuk beban publik tinggi.
- Tidak ada mekanisme auto-update konten menjadi unik, jaminan ranking/indexing, atau penghapusan error GSC secara instan. Saat sumber memberi soft 404 dengan status 200, sumber tersebut tetap perlu diperbaiki.