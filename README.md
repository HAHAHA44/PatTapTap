# 拍拍 PatPatTap

桌面角落的迷你节奏练习器（macOS / Windows），支持中英文。Tauri 2 + React + TypeScript。

## 运行

```bash
npm install
npm run tauri dev      # 开发
npm run tauri build    # 打包（在对应系统上分别打包）
```

需要 Node 和 Rust（`rustup`）。Windows 打包需要在 Windows 上进行（WebView2 + MSVC）。

## 用法

- 控件默认在屏幕右下角，可拖动，靠近边缘自动吸附。
- **双击**控件开始 / 停止；**右键**打开菜单；托盘（菜单栏）图标里有完整菜单。
- 默认快捷键：`Alt+Shift+B` 开始 / 停止，`Alt+Shift+H` 老板键（隐藏 / 显示）。
- 默认打拍键 `F`（双键轮敲为 `F` + `J`），可在设置里改。
- macOS 首次使用需要在「系统设置 → 隐私与安全性 → 输入监控」里授权 PatPatTap，才能在其他软件里打拍；未授权时可先点一下控件，在控件里打拍。

## 目录结构

```
src/core/        纯 TS 核心（无 Tauri 依赖，可复用到手机 / 网页版）
  engine.ts        调度（Web Audio 提前调度）+ 判定
  pattern.ts       节奏型数据、内置预设、编辑操作
  settings.ts      设置结构、默认值、校验
  stats.ts         统计与练习小结
src/platform/    Tauri 胶水层（存储、事件、窗口定位）
src/widget/      桌面小控件
src/settings/    设置窗口（节奏型编辑器、延迟校准、记录）
src-tauri/src/keys/  全局按键监听（macOS CGEventTap / Windows 低级键盘钩子，只监听不拦截）
```

## 隐私

全局监听只在练习时转发你设置的打拍键，不记录、不上传任何其他按键；所有数据只存在本机。

## 规划

- 二期：邮箱注册登录、好友、排行榜、每日挑战、好友比试、云同步
- 后续：桌宠形态、手机版
