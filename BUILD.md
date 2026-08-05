# Windows 打包说明

本仓库只提交应用源码，不提交 Electron 运行时或生成的安装包。

1. 在 `windows/app` 中安装 Electron `35.1.5`。
2. 将 Electron 的 `dist` 目录复制为一个新的发布目录。
3. 将 `windows/app`（不含 `node_modules`）复制到发布目录的 `resources/app`。
4. 将 `electron.exe` 重命名为 `StockPet人民币盈亏.exe`。
5. 将根目录 `LICENSE` 复制为发布目录中的 `LICENSE-StockPet-MIT.txt`，并复制 `windows/app/第三方说明.txt`。
6. 运行 `node --test windows/test/lib.test.js` 后，压缩整个发布目录并以版本号命名。

请不要覆盖 Electron 运行时自带的 `LICENSE` 与 `LICENSES.chromium.html`。
