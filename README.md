# VPS Ops Console

Desktop/local tool để quản lý VPS, command, tunnel, và terminal realtime.

## Chạy web local

```powershell
cd C:\Users\ADMIN\Documents\Codex\2026-05-04\t-i-mu-n-l-m
node server.js
```

Mở `http://localhost:8080`.

## Chạy dạng desktop app

Cài dependencies lần đầu:

```powershell
cd C:\Users\ADMIN\Documents\Codex\2026-05-04\t-i-mu-n-l-m
npm install
```

Mở desktop app:

```powershell
npm run desktop
```

Hoặc chạy cả server + Electron dev cùng lúc:

```powershell
npm run dev
```

## File desktop

- Electron entry: `electron-main.js`
- Web backend: `server.js`
- UI: `index.html`

## Ghi chú

- Desktop app sẽ tự khởi động local server rồi mở UI.
- Nếu cổng `8080` đang bị app khác chiếm, cần đổi port trong `server.js` và `electron-main.js`.

## Auto Updater

App đã được scaffold auto-updater bằng `electron-updater`.

### Cách hoạt động
- Khi app packaged chạy, nó sẽ đọc cấu hình update từ file `update-config.json` đi kèm app hoặc `%APPDATA%/VPS Ops Console/update-config.json`.
- Nếu cấu hình hợp lệ, app sẽ check update sau khi mở app vài giây.
- Nếu có bản mới, app sẽ hỏi bạn có muốn tải không.
- Khi tải xong, app sẽ hỏi cài và khởi động lại.

### Cấu hình updater (GitHub Releases)
File `update-config.json` trong app đã được cấu hình sẵn:

```json
{
  "provider": "github",
  "owner": "trnghuey",
  "repo": "vps-ops-console",
  "private": false,
  "releaseType": "release"
}
```

### Cách publish bản mới
1. Commit code và tăng `version` trong `package.json`.
2. Set token (PowerShell): `setx GH_TOKEN "YOUR_GITHUB_TOKEN"`
3. Mở terminal mới, chạy 1 lệnh: `npm run release:github`
4. Script sẽ tự build + upload release artifacts lên GitHub Releases.

Từ lần mở app sau, bản đã cài sẽ tự check update từ GitHub Releases.

### Ghi chú GitHub token
- Nếu sau này muốn auto-publish release ngay từ máy build, hãy tạo biến môi trường `GH_TOKEN` trước khi chạy `npm run dist`.
- Với repo public, runtime updater không cần token để tải bản mới.
