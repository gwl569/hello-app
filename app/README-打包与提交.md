# Hello · 打包成 iOS App 并提交 App Store

这个文件夹是 Capacitor 工程骨架，网页本体在上层的 `../web`，**不用复制两份**：
改完 `web/` 里的东西，跑一次 `npm run ios:sync` 就同步进 App。

## 一次性准备

1. 一台 Mac（或云 Mac），装好 **Xcode**（App Store 里下）和 Node.js。
2. 申请 **Apple Developer Program**（99 美元/年，需实名 + 双重验证）。

## 在 Mac 上执行（在 `app` 这个文件夹里）

```bash
npm install          # 装 Capacitor 和本地通知插件
npm run ios:add      # 生成 ios 工程（只需一次）
npm run ios:sync     # 把 ../web 的网页同步进 App（每次改完网页都要跑）
npm run ios:open     # 用 Xcode 打开 ios 工程
```

## 在 Xcode 里做四件事

1. 左侧选中 `App` → **Signing & Capabilities** → Team 选你的开发者账号；
   Bundle Identifier 用 `com.mec.hello`（想改的话，`capacitor.config.json` 里的 `appId` 要一起改）。
2. 把 `../icons/AppIcon.appiconset` **整个文件夹拖进** `App/Assets.xcassets`，删掉原来那个 AppIcon 占位。
3. **Info.plist** → `Bundle Display Name` 填 `Hello`（应用名）。
4. 真机跑一遍确认没问题，然后 **Product → Archive → Distribute App → App Store Connect → Upload**。

上传完成后到 App Store Connect 建 App、贴文案和截图（`../app-store/截图/` 里已经准备好），提交审核。

## 每日提醒是怎么工作的

`../web/native.js` 里的代码只在原生 App 里生效：点「开启每日提醒」会申请通知权限，
然后每天 8:00 用一句随时段的问候提醒你。网页版打开时这段代码直接跳过，不会打扰。

想再加桌面小组件（WidgetKit 显示今日待办）的话跟我说，那需要写 Swift 小组件 + 一个共享存储，
我可以把代码准备好。

## 审核提醒

Apple 审核指南 4.2 会拒绝"只是把网站套进 WebView"的 App。现在这版已经有：
离线可用、本地通知提醒、本机数据存储 —— 提交时在审核备注里写清楚这些功能，
并确保 App 内不出现"网页版"字样，通过率会高很多。
