# Windows 打包说明

本仓库只提交应用源码，不提交 Electron 运行时或生成的安装包。

## 版本号规则

- 定制版自身的功能新增、修复和界面调整只递增第三位，例如 `v0.2.1` 到 `v0.2.2`。
- 只有同步原版 StockPet 的新版本时，才递增第二位，例如 `v0.2.x` 到 `v0.3.0`。
- 新发布版本统一使用完整的三段版本号。

1. 在 `windows/app` 中安装 Electron `35.1.5`。
2. 将 Electron 的 `dist` 目录复制为一个新的发布目录。
3. 将 `windows/app`（不含 `node_modules`）复制到发布目录的 `resources/app`。
4. 将 `electron.exe` 重命名为 `StockPet-PnL.exe`。
5. 将根目录 `LICENSE` 复制为发布目录中的 `LICENSE-StockPet-MIT.txt`，并复制 `windows/app/第三方说明.txt`。
6. 运行 `node --test windows/test/lib.test.js` 后，压缩整个发布目录并以版本号命名。

请不要覆盖 Electron 运行时自带的 `LICENSE` 与 `LICENSES.chromium.html`。

## Release 更新说明格式

每个版本均按以下顺序编写，未涉及的项目可以省略：

```markdown
基于 [YellowPancake/StockPet](https://github.com/YellowPancake/StockPet) 修改；原项目版权归 YellowPancake 所有，遵循 MIT License。

## 更新内容

- 本版本的功能、修复或兼容性变化

## 下载与运行

- 安装包：`StockPet-PnL-Windows-x64-vX.Y.Z.zip`
- 解压目录：`StockPet-PnL`
- 启动程序：`StockPet-PnL.exe`

请完整解压后再运行，请勿单独移动 EXE 文件。

## 文件校验

SHA-256：`安装包哈希`
```
