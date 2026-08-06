# StockPet P&L

Windows 桌面盯盘工具的个人定制版，首个自定义发布版本为 `v0.1.0`。

## 来源与许可证

本项目基于 [YellowPancake/StockPet](https://github.com/YellowPancake/StockPet) 修改。原项目版权归 YellowPancake 所有，并以 MIT License 发布；本仓库和发布包均保留该许可证文本。

## 本版改动

- 每只自选股可填写成本价、持仓数量和原币兑人民币汇率。
- 自动计算并展示单只与合计人民币持仓盈亏。
- A 股默认按人民币汇率 `1` 计算；港股、美股需由使用者填写自己的换汇价。
- 已关闭上游 StockPet 的软件更新入口，避免覆盖本定制功能；仅检查本仓库的 GitHub Releases。
- 启动时会自动检查自定义版本；发现新版并确认后，会自动下载、校验、替换并重启。
- 分时曲线宽度下限由 `220px` 降为 `120px`。

## 使用提示

持仓、成本价、数量和汇率仅保存在软件目录的 `data` 文件夹中，不会上传到本仓库。删除软件时如需保留数据，请先备份该文件夹。盈亏数据不包含佣金、税费、融资利息或汇兑成本；行情可能延迟，不构成投资建议。

## 发布包

每个 Release 提供 Windows x64 完整文件夹压缩包。解压后运行 `StockPet-PnL.exe`，请不要将 EXE 单独移出文件夹。

## 第三方组件

Windows 发布包含有 Electron 运行时，其随包许可证和 Chromium 第三方声明分别保存在发布文件夹中的 `LICENSE` 与 `LICENSES.chromium.html`。详情见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
