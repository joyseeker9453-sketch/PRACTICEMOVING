# 給 AI 助手的專案須知

**先讀完這份再動手。這個專案有兩個平行的 repo，很多「看起來像 bug」的東西是刻意的。**

---

## 一、這個 repo 的身分

| 項目 | 值 |
|---|---|
| 角色 | 正式站（對外營運中） |
| GitHub | `drjennyleiclinic-lgtm/drjennyleiclinic-site` |
| Cloudflare Worker 名稱 | `drjennyleiclinic` |
| 實際網址 | `https://drjennyleiclinic.drjennyleiclinic.workers.dev` |

另一個 repo 是 **練習站**：`joyseeker9453-sketch/PRACTICEMOVING`（網址 `https://practicemoving.joyseeker9453.workers.dev`）。
兩邊程式碼幾乎相同，改動流程是「先在練習站做、驗證過再搬到正式站」。

---

## 二、baseUrl —— 不要再說它需要修正 ⚠️

`content/site.json` 的 `baseUrl` 目前是：

```
https://drjennyleiclinic.drjennyleiclinic.workers.dev
```

**這是正確的，不要改。** 它必須等於這個 repo 實際被服務的網址。

歷史背景：正式站的 baseUrl 曾經誤填成練習站的網址，導致 canonical / og:url 指向錯的站。
那個問題已經在 2026-09-17 修正完畢並驗證過。如果你看到它是上表的值，**那就是對的狀態**。

唯一需要改動的情況是綁定自訂網域（例如 `https://jenny-clinic.com`）。
那時候由診所人員到後台「診所資料 → 網站網址」改，**不要改 code**，也不要幫忙「順手改好」。

---

## 三、絕對不要在兩個 repo 之間複製的檔案 ⚠️

搬移改動時，這三個一複製就會把兩個站接錯線：

| 檔案 | 為什麼 |
|---|---|
| `wrangler.jsonc` | `name` 綁 Cloudflare 專案，複製會讓部署指到另一個站 |
| `content/site.json` 的 `baseUrl` | 見上一節 |
| `admin/config.yml` 的 `repo` / `base_url` / `site_url` / `display_url` | 綁 GitHub repo 與登入中繼 Worker，複製會讓後台去改另一個 repo |

`content/announcements.json`、`content/articles/`、`content/about.json` 是各站自己的內容，
除非明確要求同步內容，否則也不要複製。

---

## 四、build.js 會自動產生的檔案 —— 不要手改

部署時 Cloudflare 執行 `npm run build`。`build.js` 會寫出：

```
data/articles.json      data/announcements.json    data/content.js
styles.css              sitemap.xml                robots.txt
article/<slug>/index.html                          notices/index.html
team/index.html
index.html 的 <!--OG:START--> ~ <!--OG:END--> 區段
```

重點：

- **`index.html` 會被 build.js 回頭覆寫一部分**。`OG:START` 到 `OG:END` 之間的
  canonical / og:url / og:image / schema.org 由 `baseUrl` 和 `site.json` 重新產生。
  在那區段裡手動改東西沒有意義，下次部署就沒了。那兩個標記也不能刪。
- repo 裡 committed 的 `data/*.json` 是**過期殘留**，跟 `content/` 對不上是正常的。
  每次部署都會重新產生，不需要修、也不需要 commit 更新版本。

---

## 五、Markdown 渲染 —— 已經統一過，不要改回去

公告與文章的 Markdown 由 `build.js` 的 `renderMarkdown()` 處理：
`marked`（解析）→ `sanitize-html`（白名單過濾）。

首頁公告條、`/notices/` 公告頁、文章頁**共用同一顆引擎**。
Sveltia 後台預覽用的也是 marked，所以預覽跟實際輸出一致。

刻意的設計，不要「修正」：

- **標題降一級**：後台的 `#` 輸出成 `<h2>`、`#####` 和 `######` 都收斂到 `<h6>`。
  因為頁面本身已有一個 `h1`，避免重複。
- **不碰 marked 的 renderer API**：改用「前處理文字 + 後處理 HTML」。
  這是為了跨大版本相容（marked 12 與 18 輸出已驗證逐字相同）。
- **白名單不含表格**：`<table>` 系列會被過濾掉。診所人員不使用表格語法。
- **FB 貼文殘留處理**：fbcdn 表情圖示還原成文字、facebook.com/hashtag 連結拿掉外連留文字。

---

## 六、首頁公告的高度策略

`content/site.json` 的 `announcementHeightMode` 是全站預設（目前 `scroll`），
每則公告可用 `heightMode` 覆蓋（`inherit` / `scroll` / `clip` / `full`）。
兩者都有對應的後台選單，**不是寫死的值，不要改成常數**。

`/notices/` 公告頁一律完整顯示，不受這個設定影響。

---

## 七、工作方式

- 診所人員不是工程師。解釋要講「改哪個檔、哪一行、為什麼」，但不用教寫 code。
- **不要自行 commit 或 push。** 產出檔案交給對方自行上傳到 GitHub，並明確說明每個檔案
  要放到 repo 的哪個路徑。
- 驗證要用實測：Cloudflare build 完之後開線上版確認
  （看 `/data/content.js` 第一行建置時間、網址加 `?v=數字` 避快取），
  不要用「應該沒問題」交差。
- 不要用下載到本機的 `index.html` 雙擊開來驗證。`/images/...` 是絕對路徑，
  只有在真正的網站根目錄下才找得到，本機開一定會破圖，那不是 bug。
