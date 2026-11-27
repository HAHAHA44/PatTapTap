# 拍拍 PatPatTap

桌面角落的迷你节奏练习器（macOS / Windows），支持中英文。Tauri 2 + React + TypeScript。

## 运行

```bash
npm install
npm run tauri dev      # 开发
npm run tauri build    # 打包（在对应系统上分别打包）
```

需要 Node 和 Rust（`rustup`）。Windows 打包需要在 Windows 上进行（WebView2 + MSVC）。

在线功能（账号、每日挑战、排行榜、好友比试、记录同步）需要后端，用 Docker 启动：

```bash
cp deploy/.env.example deploy/.env   # 填两个随机密钥
npm run server:up                     # API 在 http://localhost:8787，邮件在 http://localhost:8025
```

上线部署、备份、配置项见 [deploy/README.md](deploy/README.md)。打包时用 `VITE_API_URL=https://你的域名` 指定服务器。

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
  challenge.ts     每日挑战 / 比试的谱面生成与判定（桌面端和服务器共用）
src/platform/    Tauri 胶水层（存储、事件、窗口定位、服务器 API、记录同步）
src/widget/      桌面小控件
src/settings/    设置窗口（节奏型编辑器、延迟校准、记录）
src-tauri/src/keys/  全局按键监听（macOS CGEventTap / Windows 低级键盘钩子，只监听不拦截）
server/          后端（Node.js + Fastify，PostgreSQL + Redis）
deploy/          Docker Compose（开发 / 线上）、Caddy、备份
```

## 隐私

全局监听只在练习时转发你设置的打拍键，不记录、不上传任何其他按键。

不登录时所有数据只存在本机。登录后会上传：练习记录（用于多台电脑同步）、每日挑战和比试时的按键时间（由服务器判分）。导入的歌曲文件永远不会上传。登录凭据保存在系统钥匙串（macOS 钥匙串 / Windows 凭据管理器）里。

## 规划

- 已完成二期：邮箱注册登录、好友、排行榜、每日挑战、好友异步比试、记录同步
- 后续：实时比试、防作弊增强、桌宠形态、手机版

## 第三方组件

- **Beat This!**（`public/models/beat_this_small.onnx`）：节拍与小节识别模型，small0 检查点导出为 ONNX。MIT 许可，© 2024 Institute of Computational Perception, JKU Linz。许可证见 `public/models/BEAT_THIS_LICENSE.txt`，项目地址 https://github.com/CPJKU/beat_this
- **onnxruntime-web**：在分析线程里运行上述模型（WebAssembly），MIT 许可。
