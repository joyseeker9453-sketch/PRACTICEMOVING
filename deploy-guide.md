# 晨昕診所官網 — Cloudflare Pages 部署說明

整體架構：**GitHub 存放內容 → Cloudflare Pages 免費託管 → /admin 圖形後台給醫師改內容**。
一次性設定約 30–60 分鐘（步驟一～五），之後日常維護零指令、零費用。

```
專案結構
├── index.html                 主網站（不需要再動）
├── build.js / package.json    部署時自動把 content/ 轉成 data/（不需要動）
├── admin/                     醫師用的圖形後台（config.yml 部署時改兩行）
├── content/
│   ├── announcements.json     公告（後台編輯）
│   └── articles/*.md          文章（後台編輯）
└── images/uploads/            後台上傳的圖片會放這裡
```

---

## 步驟一：把專案放上 GitHub

1. 註冊/登入 github.com（用診所的信箱申請一個帳號）
2. 右上角「+」→ New repository → 名稱填 `chenxin-clinic-site` → Private 或 Public 皆可 → Create
3. 進 repo → 「uploading an existing file」→ 把整個資料夾內容拖進去 → Commit changes

## 步驟二：接上 Cloudflare Pages

1. 註冊/登入 dash.cloudflare.com
2. 左側 **Workers & Pages** → Create → **Pages** → Connect to Git → 授權並選 `chenxin-clinic-site`
3. 建置設定：
   - Build command：`node build.js`
   - Build output directory：`/`（根目錄）
4. Save and Deploy → 一分鐘後得到 `https://xxx.pages.dev` 網址，主網站此時就能看了

之後每次內容有變動（後台按發布），Cloudflare 會自動重新建置部署，約 1 分鐘生效。

## 步驟三：設定後台登入（一次性，最繁瑣的一步）

後台用 GitHub 帳號登入，需要一個小型的 OAuth 中繼服務（免費跑在 Cloudflare Workers 上）：

1. 開 `github.com/sveltia/sveltia-cms-auth` → 按頁面上的 **Deploy to Cloudflare Workers** 按鈕 → 照指示部署，得到一個 `https://xxxx.workers.dev` 網址（記下來）
2. 回 GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App：
   - Homepage URL：你的 pages.dev 網址
   - Authorization callback URL：`https://xxxx.workers.dev/callback`
   - 建立後取得 **Client ID**，並產生一組 **Client Secret**
3. 回 Cloudflare → 該 Worker → Settings → Variables，新增三個環境變數：
   - `GITHUB_CLIENT_ID` = 剛才的 Client ID
   - `GITHUB_CLIENT_SECRET` = 剛才的 Client Secret
   - `ALLOWED_DOMAINS` = 你的網站網域（如 `xxx.pages.dev`，日後有自訂網域再加上）

## 步驟四：改 config.yml 兩行

編輯 `admin/config.yml`（GitHub 網頁上按鉛筆改即可）：

```yaml
repo: 你的GitHub帳號/chenxin-clinic-site
base_url: https://xxxx.workers.dev        # 步驟三的 Worker 網址
```

Commit 後等自動部署完成，開 `https://你的網址/admin` → 用 GitHub 登入 → 應該就能看到「診所公告」「健康新知」兩個區塊。

## 步驟五（選配）：自訂網域

Cloudflare Pages → 你的專案 → Custom domains → 加上 `chenxin-clinic.com` 之類的網域。
網域直接在 Cloudflare 買最省事（成本價，.com 約 US$10/年），SSL 自動配好。

---

## 每年費用

| 項目 | 費用 |
|---|---|
| Cloudflare Pages 託管 + 自動部署 | NT$0 |
| Cloudflare Workers（後台登入中繼） | NT$0（免費額度每日 10 萬次請求，診所用不到 1%） |
| GitHub（內容儲存 + 版本紀錄） | NT$0 |
| Sveltia CMS 後台 | NT$0（開源） |
| SSL 憑證 | NT$0（自動） |
| 網域 .com | 約 NT$350/年（Cloudflare 成本價） |

**年度總維護成本 = 網域費，約 NT$350–800。不買網域則為 NT$0。**

## 誰能登入後台？

能登入後台的人 = 對該 GitHub repo 有寫入權限的 GitHub 帳號。
要讓醫師自己登入：GitHub repo → Settings → Collaborators → 邀請醫師的 GitHub 帳號。
建議做法：幫診所申請一個共用 GitHub 帳號給醫師用，權限最單純。

## 掛掉了怎麼辦（給老闆的答案）

- 網站本體是純靜態檔案，沒有資料庫、沒有後端程式，**沒有會「掛」的元件**；Cloudflare 的可用性與大型網站同級。
- 所有內容（含每一次修改的完整歷史）都在 GitHub repo 裡。就算 Cloudflare 明天消失，任何工程師都能把同一個 repo 在別的託管平台十分鐘內重新上線。
- 唯二要顧的：GitHub 帳號密碼保管好、網域設自動續費。
