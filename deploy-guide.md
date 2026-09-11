# 晨昕診所官網 — 搬家／部署說明（Cloudflare Workers + GitHub + Sveltia 後台）

架構：**GitHub repo 存所有內容 → Cloudflare Workers 自動建置、託管網站 → /admin 後台（Sveltia）改內容時，其實是在改 GitHub repo。**

所以「後台改了、網站沒變」一定是這條鏈子某一段沒接上：
**後台（config.yml 的 repo） → GitHub repo → Cloudflare 自動建置（build.js） → 網站。**
每一步後面都有「✅ 驗收」，**驗收沒過不要做下一步**。

---

## 需要改的地方總表（搬家時全部要改，漏一個就會出問題）

- `admin/config.yml` → `repo:`（新帳號/新 repo）
- `admin/config.yml` → `base_url:`（新的登入中繼 Worker 網址）
- `admin/config.yml` → `site_url:`、`display_url:`（新網站網址）
- `wrangler.jsonc` → `"name"`（必須和 Cloudflare 上的 Worker 名稱一模一樣）
- 後台「診所資料 → 網站網址」（= `content/site.json` 的 `baseUrl`，分享連結、Google 用）
- 登入中繼 Worker 的環境變數 `ALLOWED_DOMAINS`（要包含所有會開 /admin 的網域）
- GitHub OAuth App 的兩個網址

`robots.txt`、`sitemap.xml`、分享連結、og 標籤都會自動跟著「網站網址」產生，不用手改。

---

## 步驟 0：搬家前

1. 用診所 Google 帳號分別註冊 **GitHub**、**Cloudflare**（都選「用 Google 登入」即可）。GitHub 帳號務必開兩步驟驗證。
2. **凍結舊後台**：從步驟 1 開始到步驟 4 驗收完，**不要再用舊的後台改任何東西**。搬家是複製當下的內容，之後在舊後台改的不會跟過來。

## 步驟 1：搬 GitHub repo（連同全部歷史紀錄）

1. 新 GitHub 帳號 → 右上角「+」→ **Import repository**
2. 舊 repo 網址填 `https://github.com/joyseeker9453-sketch/WEBSITETESTING`
3. 新 repo 名稱例如 `chenxin-clinic-site`，建議選 **Private**（私人 repo 後台照樣能用）→ Begin import

✅ 驗收：新 repo 裡看得到 `content/articles/` 全部文章、`images/uploads/` 全部圖片，commit 紀錄和舊 repo 一樣。

## 步驟 2：Cloudflare 建網站

1. 先在新 repo 編輯 `wrangler.jsonc`，把 `"name"` 改成你要的 Worker 名稱，例如 `chenxin-clinic`（只能小寫英文、數字、減號）
2. Cloudflare → **Workers & Pages** → Create → **Import a repository** → 授權 GitHub、選新 repo
3. 設定：
   - Project name：**和 wrangler.jsonc 的 name 完全相同**（不同的話建置會失敗）
   - Build command：`npm run build` ← **一定要填**，沒填的話網站永遠停在 repo 裡舊的 data/，後台怎麼改都不會變
   - Deploy command：保持預設 `npx wrangler deploy`
4. Save and Deploy，完成後得到 `https://chenxin-clinic.xxxx.workers.dev`

✅ 驗收：
- 打開 workers.dev 網址，首頁、文章、公告頁都正常
- 打開 `網址/data/content.js`，**第一行**寫著「建置時間 …（commit xxxxxxx）」：時間是剛剛、commit 是 7 碼英數字（不是 `local`）→ 代表建置有跑

## 步驟 3：後台登入中繼（sveltia-cms-auth）

1. 開 `https://github.com/sveltia/sveltia-cms-auth` → 按 **Deploy to Cloudflare** → 部署到新 Cloudflare 帳號 → 記下網址，例如 `https://sveltia-cms-auth.xxxx.workers.dev`
2. 新 GitHub 帳號 → Settings → Developer settings → **OAuth Apps** → New OAuth App：
   - Homepage URL：步驟 2 的網站網址
   - Authorization callback URL：`https://sveltia-cms-auth.xxxx.workers.dev/callback`（結尾是 /callback）
   - 建立後複製 Client ID，再按 Generate a new client secret 複製 Client Secret（只會顯示一次）
3. Cloudflare → sveltia-cms-auth 這個 Worker → Settings → Variables and Secrets：
   - `GITHUB_CLIENT_ID` = Client ID
   - `GITHUB_CLIENT_SECRET` = Client Secret（類型選 Secret）
   - `ALLOWED_DOMAINS` = 所有會開 /admin 的網域，逗號分隔，例如
     `chenxin-clinic.xxxx.workers.dev, jenny-clinic.com, www.jenny-clinic.com`
     （**漏了哪個網域，從那個網域開後台就登不進去**）

## 步驟 4：接上後台（最關鍵的一步）

在新 repo 編輯 `admin/config.yml`：

```yaml
backend:
  name: github
  repo: 新GitHub帳號/chenxin-clinic-site         # ← 沒改這行 = 後台會去改舊 repo
  branch: main
  base_url: https://sveltia-cms-auth.xxxx.workers.dev
  auth_endpoint: auth
site_url: https://chenxin-clinic.xxxx.workers.dev
display_url: https://chenxin-clinic.xxxx.workers.dev
```

Commit，等 1～2 分鐘自動部署。

✅ 驗收（**這就是上次「登入了但沒連動」的檢查**，每項都要過）：
1. 開 `新網址/admin/` → 用**診所 GitHub 帳號**登入 → 看得到四個集合
2. 隨便改一個小地方（例如公告內容加一個字）→ 儲存
3. 到**新 repo** 的 Commits 看到剛剛那筆（如果出現在舊 repo，就是 repo: 那行沒改到）
4. 等 1～2 分鐘，`新網址/data/content.js` 第一行的建置時間更新、commit 碼等於新 repo 最新那筆 → 首頁看得到剛剛的修改
5. 把剛剛的測試修改改回來

## 步驟 5：綁正式網域

**如果網域目前不在 Cloudflare**（例如 jenny-clinic.com 在別家註冊、舊網站也掛在上面）：
1. Cloudflare → Add a domain → 輸入網域 → Free 方案
2. Cloudflare 會自動掃描現有 DNS 紀錄。**先登入原本的網域商，把所有 DNS 紀錄抄下來逐筆對照**，特別是 **MX（信箱）**、**TXT（Google 驗證等）**。漏了 MX，網域信箱會收不到信
3. 對照無誤後，到原網域商把 Nameserver 改成 Cloudflare 給的兩組，等生效（幾分鐘到 24 小時）

**網域進 Cloudflare 之後：**
1. Workers & Pages → 網站 Worker → Settings → **Domains & Routes** → Add → Custom domain → 輸入 `jenny-clinic.com`（要 www 的話再加一個 `www.jenny-clinic.com`）
2. 後台「診所資料 → 網站網址」改成 `https://jenny-clinic.com` → 儲存
3. `admin/config.yml` 的 `site_url`、`display_url` 改成正式網址
4. 確認 `ALLOWED_DOMAINS` 已含正式網域；OAuth App 的 Homepage URL 改成正式網址

✅ 驗收：
- `https://jenny-clinic.com/robots.txt` 最後一行是新網域的 sitemap
- 任一篇文章按「複製連結」，貼出來是新網域
- 從 `https://jenny-clinic.com/admin/` 能登入並存檔（重做一次步驟 4 的驗收）

## 步驟 6：處理舊站（新站驗收全部通過之後才做）

1. **舊 repo 封存**：舊 repo → Settings → 最下面 **Archive this repository**。封存後變唯讀，舊後台就算有人登入也存不了，**不會再發生「改到舊站」**
2. **舊網域轉址**：舊 Cloudflare 帳號 → `mdytcdemowebsite.com` → Rules → Redirect Rules → 全部 301 轉到新網域（避免 Google 把兩個網站當成重複內容）。不打算保留舊網域的話，直接把舊 Worker 的自訂網域移除即可
3. 舊的登入中繼 Worker（uploadcontent）和舊 OAuth App 可以刪除

## 步驟 7：正式上線前的內容清理

- 公告「這是DEMO 用 並不是正式診所網站」→ 關閉「公開」或刪除
- 兩篇示範文章 `demo-sleep`、`demo-adhd` → 刪除（它們用的「身心科」分類也不在分類清單裡）
- 「診所資料 → 分享預覽圖」換成一張 1200×630 的正式圖（現在用的是舊版 LINE 橫幅）
- Google Search Console 新增正式網域 → 提交 `https://jenny-clinic.com/sitemap.xml`

---

## 誰能登入後台

能登入 = 對新 repo 有寫入權限的 GitHub 帳號。
- 共用診所帳號：最單純，直接用
- 醫師用自己的 GitHub 帳號：新 repo → Settings → Collaborators → 邀請 → **醫師要到信箱按「接受邀請」**，沒接受的話可以登入、但存檔會失敗

## 「後台改了網站沒變」對照表

- **新 repo 沒有出現剛剛的 commit** → `config.yml` 的 `repo:` 還是舊的，或登入的 GitHub 帳號沒有寫入權限（邀請沒接受）
- **新 repo 有 commit，但 `data/content.js` 建置時間沒變** → Cloudflare 自動建置沒跑或失敗：Workers & Pages → 網站 Worker → Deployments / Builds 看紅字；最常見是 Build command 沒填、或 Worker 名稱和 wrangler.jsonc 不一致
- **`data/content.js` 時間有變，但首頁看起來沒變** → 瀏覽器快取：強制重新整理（Windows `Ctrl+F5`、Mac `Cmd+Shift+R`），或開無痕視窗看
- **按登入跳出錯誤、或登入視窗關不掉** → `ALLOWED_DOMAINS` 沒包含目前網址，或 OAuth App 的 callback 網址打錯（要以 `/callback` 結尾）
- **登入中繼整個壞掉的緊急備案** → 後台登入畫面選「使用存取權杖登入」（Sign In Using Access Token），用 GitHub 的 Personal Access Token（權限只給這個 repo 的 Contents 讀寫）登入

## 費用

Cloudflare Workers 免費方案（靜態檔案流量不計費）、GitHub、Sveltia 都是 NT$0；只有網域每年約 NT$350–800。
