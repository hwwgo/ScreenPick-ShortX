# 屏幕取字 · ShortX 脚本

一个 ShortX（ExecuteJS）剧本：**全屏悬浮指针**，拖到文字上松手即取字；按住不动 1.5 秒进入**框选截图 + OCR**。

- 当前版本：**v7.33.11**（versionCode **50**）
- 形态：单文件 ES5 脚本 + ShortX 导入文件，无第三方依赖
- `dist/` 放可直接导入的文件，`docs/` 放版本说明

> 只支持 ShortX 运行环境（脚本调用 `shortx.getUiAutomation()`、`shortx.getShortXDir()` 与 ShortX 的 OCR 类）。不依赖 ShortX 的独立实现是另一个 APK 项目，不在本仓库。

---

## 功能

| 能力 | 说明 |
|---|---|
| 指针取字 | 尖端命中控件 → 读 a11y 文本，结果写剪贴板并吐司 |
| OCR 兜底 | a11y 不可用的页面（云闪付、Canvas、游戏）自动降级 OCR |
| 框选截图 | 悬停 1.5s 进入，拖动选区，松手即截图，第二指取消 |
| 选区 OCR | 截图后对选区跑 OCR，文字同样写剪贴板并吐司 |
| 边缘加速 | 距右/下缘 53dp 内渐变加速（越靠边越快，累计约 1.9×），约 15dp 处贴边 |
| 单实例防护 | 内存引用 + 标志文件（pid + 开机批次），重启后残留标志自动判失效 |
| 启动健壮性 | build 12s 超时自动拆窗、300s 全局看门狗、屏幕指标三级回退 |
| 手感一致 | 取字与框选共用同一套偏移/加速计算 |

---

## 安装

1. 把 `dist/屏幕取字_V7.33.11_ShortX导入.txt` 传到手机（放到任意目录）。
2. 打开 ShortX → 剧本列表 → **导入**，选择该 txt。
3. 若已存在同名「屏幕取字」，选择**覆盖安装**（versionCode 50 会替换旧版）。
4. 进入该剧本，确认已授予**无障碍 / UiAutomation** 与**截图**权限。
5. 给剧本绑定触发方式（ShortX 手势、磁贴、悬浮球、长按等，脚本本身不注册触发）。

导入文件包含两个动作：

```
ExecuteJS（脚本本体）
  └─ SwitchCase（解析脚本返回的 JSON，分 5 个分支）
       ├─ 失败/错误   → 吐司错误信息
       ├─ 识别就绪兜底 → 吐司「识别已就绪」
       ├─ 取消        → 吐司「用户取消」
       ├─ 取字        → 文字写剪贴板 + 吐司
       └─ 截图/OCR    → 选区 OCR → 写剪贴板 + 吐司 → 截图归档到 DCIM
```

---

## 使用

触发后出现箭头（首次会有「启动中…」，预热完成弹「识别已就绪」）。

| 操作 | 结果 |
|---|---|
| 拖动指针到文字上，松手 | 取字：文字写剪贴板，吐司显示内容 |
| 按住不动 1.5 秒 | 进入框选模式（箭头变选框） |
| 框选模式下拖动选区，松手 | 截图 → 选区 OCR → 写剪贴板 → 归档到 DCIM |
| 框选模式下按住不动 1.5 秒 | 静默退出框选，回到取字态 |
| 任意时刻第二指按下 | 取消，吐司「用户取消」 |

指针位置 = 手指位置 − 偏移量；靠近右/下边缘时偏移按 smoothstep 收缩，并叠加边缘加速，方便把箭头送到屏幕最边上。

---

## 返回的 JSON

脚本通过 `finishWithJson` 返回，SwitchCase 用 `pointerJson`（或 `jsRet`）读取。

| 字段 | 类型 | 说明 |
|---|---|---|
| `ok` | boolean | 是否成功 |
| `type` | string | `text_pick` / `area_capture` / `cancel` / `pointer_error` / `already_running` |
| `code` | string | 结果码，如 `TEXT_PICK_SUCCESS`、`USER_CANCEL`、`NO_TEXT` |
| `message` | string | 人类可读信息 |
| `value` | string | 取到的文字，或截图文件路径 |
| `data` | object | 附加数据（见下） |

```jsonc
// 取字成功
{"ok":true,"type":"text_pick","code":"TEXT_PICK_SUCCESS","message":"取字成功",
 "value":"要复制的文字",
 "data":{"hitPoint":{"x":540,"y":1200},
         "rect":{"left":100,"top":1150,"right":900,"bottom":1250,"width":800,"height":100}}}

// 截图成功
{"ok":true,"type":"area_capture","code":"AREA_CAPTURE_SUCCESS","message":"框选截图成功",
 "value":"/storage/emulated/0/DCIM/Screenshots/xxx.png",
 "data":{"name":"xxx.png","mime":"image/png","sizeBytes":123456,
         "visualRect":{...},"captureRect":{...}}}

// 取消
{"ok":false,"type":"cancel","code":"USER_CANCEL","message":"用户取消","value":"","data":{}}

// 失败（data.stage 用于定位截图阶段）
{"ok":false,"type":"pointer_error","code":"NO_TEXT","message":"未识别到控件文本","value":"",
 "data":{"error":"未识别到控件文本"}}
```

`data.toast` 仅在原生吐司三通道全部失败时出现（值为 `ready` / `cancel`），由 SwitchCase 补弹，正常路径没有该字段。

---

## 可调参数

都在脚本 `startPointerTextToPickword()` 的配置区，改完需同步更新导入文件里的 `expression`。

| 参数 | 默认 | 作用 |
|---|---|---|
| `edgeAccelDist` | `dp(53)` | 边缘加速区宽度，越大越早开始加速 |
| `edgeAccelGain` | `0.45` | 加速强度，0 关闭加速；0.35 更淡、0.6 更明显 |
| `areaHoldDelay` | `1500` | 按住不动多久进入框选（ms） |
| `areaIdleDelay` | `1500` | 框选中按住不动多久自动退出（ms） |
| `areaCaptureDelay` | `120` | 松手到实际截图之间的稳定等待（ms） |
| build 超时 | `12000` | 建窗超时后 `abortBuild` 强制拆窗（ms） |
| 全局看门狗 | `300000` | 任何路径忘记收尾时的兜底（ms） |

---

## 目录结构

```
ScreenPick-ShortX-v7.33.11/
├── README.md                              本文件
├── CHANGELOG.md                           版本沿革
├── SHA256SUMS.txt                         校验值
├── .gitignore
├── dist/
│   ├── 屏幕取字_V7.33.11_ShortX导入.txt     ← 直接导入 ShortX
│   └── screenpick_pointer_v7.33.11.js      母版脚本（可读源码）
└── docs/
    └── V7.33.11_优化说明.md                本版改动与实测数据
```

导入文件里的 `expression` 就是 `dist/screenpick_pointer_v7.33.11.js` 的内容做 JSON 转义后的结果，两者内容等价。

---

## 环境与权限

| 项 | 必需 | 说明 |
|---|---|---|
| ShortX | 是 | 提供 UiAutomation、截图、OCR（`OcrDetect`）能力 |
| 无障碍 / UiAutomation | 是 | 取字主路径；未就绪时退回 OCR |
| 截图权限 | 框选需要 | 由 ShortX 提供 |
| root（`su`） | 仅归档截图 | 导入文件末尾两条 `ShellCommand` 用 `su -c mv` 把截图从 ShortX 私有目录移到 `DCIM/Screenshots` |

没有 root 也能取字和框选，只是截图留在 ShortX 私有目录，不会出现在相册。此时删掉「截图/ocr」分支里的两条 `ShellCommand` 即可。

> 那两条命令里的目录形如 `/data/system/shortx_YfQpDzKzhqrhYpbE/data/screenshots/`，后缀与 ShortX 安装实例绑定。**重装或清数据后要改成新目录**，否则 `mv` 静默失败、相册里没有图。

---

## 常见问题

**重启后第一次运行，有吐司但没有箭头？**
v7.33.5 已修：开机早期 `DisplayMetrics` 可能读到 0×0，导致指针窗尺寸为 0。现在有三级指标回退 + 密度兜底，build 失败或 12s 超时会 `abortBuild` 拆窗收尾，不会留下吞触摸的全屏监视窗。若仍复现，先确认同一触发没有被绑定两次。

**提示「取字正在进行中」？**
单实例防护拦截了第二次运行（防止双箭头）。等上一次会话结束；若卡住，强停 ShortX 再试。

**边缘不够贴？**
`edgeAccelDist` 调到 `dp(64)` 会更早开始加速，`edgeAccelGain` 调大更激进。

**取到的是整段文字而不是一个词？**
a11y 命中返回的是控件节点文本，属预期行为；需要按行/按块取字请用框选 + OCR。

**云闪付、游戏里取不到字？**
这些页面 a11y 拿不到节点，脚本会走 OCR，需要 ShortX 的 OCR 可用。

---

## 版本沿革

| 版本 | 变更 |
|---|---|
| v7.33.4 | 重复运行防护（拒绝第二次执行，防双箭头） |
| v7.33.5 | 启动链路修复：拒绝分支立即收尾、标志文件带 pid+开机批次、指标三级回退、`abortBuild`、自检每进程一次 |
| v7.33.6 | 框选边缘磁吸（已撤销） |
| v7.33.7 | 边缘加速（80dp / 增益 0.75） |
| v7.33.8 | 增益收敛到 0.45，开机预热让路 |
| v7.33.9 | 诊断行落盘（v7.33.11 已移除） |
| v7.33.10 | 预热按 a11y 实效让路、OCR 线程后台优先级 |
| **v7.33.11** | 加速区 53dp、下线分析与日志、死参数清理、体积 −25.4% |

---

## 校验

```bash
sha256sum -c SHA256SUMS.txt
```

在解压出来的项目根目录（`dist/` 的上一级）执行即可。

---

## 许可证

未附加开源许可证，版权归作者所有。如需公开分发，请自行补充 `LICENSE`。
