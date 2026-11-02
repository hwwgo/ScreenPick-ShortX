// ============================================================
// 指针核心独立 JSON 版   V7.80 (指针核心同 V7.16)
// ShortX ExecuteJS 脚本：悬浮指针取字 / 框选截图，结果以 JSON 返回，
// 由导入文件的 SwitchCase 解析后决定后续动作。
// ============================================================
//
// 【致命约束 —— 改动前必读】
//   脚本经 Xposed 注入 system_server 主线程，未捕获异常 = 整机软重启。
//   1. 面板 = 离屏 Bitmap + 一个 ImageView。**不用 TextView**：
//      TextView.onDraw 里的 Paint.setColor(int) 会抛 IllegalArgumentException。
//   2. 面板是监视窗的子 View（ViewGroup.addView），全程不新建 overlay 窗口。
//   3. 面板期间不拆命中框窗口（hideSelectFrame 只改 alpha）。
//   4. 正在显示的 Bitmap 绝不 recycle（硬件渲染的 DisplayList 还引用着）——
//      一律延后 3s 回收。
//   5. 颜色只用 setARGB（alpha 必须 255）；ACTION_UP 里不查 a11y
//      （postDelay 80ms），避免与 InputDispatcher 互等。
//
// 【运行链路】
//   入口 → 单实例防护（内存引用 / 标志文件 pid + 开机批次）
//   → runOnMainSync(build, 12s)：建指针窗、框选捕获窗、全屏监视窗
//   → DOWN 定位 / MOVE 拖动（后台线程查询）/ UP 取字或出框
//   → finishWithJson（幂等）→ latch.countDown → 返回 JSON
//   兜底：300s 全局看门狗（面板弹出时撤掉，改由 selectPanelHoldMs 看护）；
//   build 失败或 12s 超时走 abortBuild 强制拆窗 —— 全屏监视窗留在屏幕上
//   会吞掉整机触摸。
//
// 【查询】a11y 优先（本会话命中过就全程走 a11y，不被 OCR 覆盖）；
//   OCR 只兜底 a11y 不可用的页面。短记忆三态：alive 走快路、expired 走
//   快路 + 后台校验、cold 走完整路径。查询永不阻塞，慢路径一律 daemon 线程。
//
// 【指针窗】尖端 = 手指 - effectiveOffset，右/下缘 smoothstep 收缩；
//   800ms/2.5s 可见性看门狗校正 alpha/visibility/scale（面板期间跳过）。
//   多指退出由全屏监视窗的四信号检测（WATCH_OUTSIDE_TOUCH 在部分 ROM 不生效）。
//
// 【框选截图】悬停 1.5s 进入 → 拖动选区 → 停止 1.5s 自动截图；第二指取消；
//   截图前框置 INVISIBLE、内缩 1dp，保证边缘内容不被裁掉。
//
// 【吐司】**脚本里一条都没有**。V7.66 起所有吐司都交给 ShortX 指令链里的
//   「显示吐司」动作（见导入文件的「截图/分享」分支），脚本不持有任何 UI
//   通道：没有 Toast 实例、没有 ShowToast 动作调用、也没有 daemon 线程。
//   落盘与分享：**全部在指令链里，脚本一行不做**（V7.72 起）。三段短命令，
//   各干一件事，和 V7.63~V7.67 那套能进相册的结构一致：
//     ① mv    ← 把 ShortX 私有目录里的 png 搬进 DCIM/Screenshots
//     ② scan  ← content call --uri content://media --method scan_file
//     ③ am    ← 只有「分享」分支才有：am start SEND（V7.73 起用 file://）
//   存图分支 = ①②；分享分支 = 吐司 + ①②③。脚本**不写任何文件**。
//   V7.73 的 am 就是用户在终端模拟器里验证过的那条：
//     su -c am start -a android.intent.action.SEND -t "image/*" \
//            --eu android.intent.extra.STREAM "file://<图片路径>" \
//            --grant-read-uri-permission
//   不再查 MediaStore 的 _id（那条要 content query + 重试循环，600 多字符，
//   从没在真机跑通过）。file:// 是本机 am 直发的，够用。
//   之前那三条（识别已就绪 / 正在识别文字… / 正在分享中…）的去处：
//     · 「识别已就绪」—— 删除。面板出现本身就是就绪；
//     · 「正在识别文字…」—— 松手那一刻指令链还没开始跑（脚本还在 OCR 里），
//       动作插不进来，改由面板内的 panelNotice 承担；
//     · 「正在分享中…」—— 移到「截图/分享」分支的第一条动作。
//   其余诊断一律写 probe.log。
//
// 【V7.74 减法】用户确认分享链路跑通后做的清理，只删不加：
//   · 导入侧：「失败/错误」分支整块删除（MatchJS + ExecuteJS 两个节点）。
//     它算出的 pointerErrorText 从来没有动作消费 —— 出错时 SwitchCase 无分支
//     命中，静默结束。脚本这边 finishError 保留（它负责 countDown 收尾）。
//   · 脚本侧：.share_uri 交接口（写文件名给 shell 读）整套删。V7.72 起 shell
//     用 ls -t 自己取最新，没人读这个文件。
//   · 交付 JSON 只留导入侧真正读的字段：visualRect / captureRect / pickedText
//     / cancel / areaAction。name / mime / sizeBytes / shareAction 无人读，删。
//   · 删掉一条纯几何诊断 panelNotice（probe 里 PANEL_GEOM 已记全）。
//
// 【面板手势】按下瞬间分类，全程不再改判：
//   · 按在字上 → 选字。已选 ≥2 且按在已选块上 = 反选（区间取反），
//     否则 = 加选；拖到文字区上下边缘会自动跟着滚。
//   · 按在卡片空白（含块内留白）→ 上下拖 = 像素级滚动，水平拖 = 不动。
//   · 点选 / 拖选都按块矩形宽松命中；判断"是字还是空白"用文字实际宽度，
//     因为块底色和卡片底几乎同色，用户看不出块边界。
//   · 只有文字区滚，标题/计数/提示/按钮固定；抬手即停，不做惯性。
//
// 【维护】
//   gen_import_v72.py（导入文件：head JSON + 分隔行 + da 动作尾，vc=100）
//   → verify_import_v72.py（结构/回归关键词）+ test_v72_*.js（node 单测）。
//   改母版必须同步校验器与单测，跑全量再交付。
//
// ============================================================
// 版本沿革（细节见各版 *_说明.md；此处只留一行结论）
// V7.0~V7.16  查询与 UI 分离、边缘感知偏移、多指退出、指针核心定型
// V7.18~V7.31  全屏监视窗做多指退出；OCR 兜底 + 缓存/预热；吐司链路；
//            短记忆三态 + 后台校验
// V7.32~V7.33.11  死代码清理；聚合判据改相对行高；重复运行防护（pid +
//            开机批次）；abortBuild；加速区 53dp
// V7.34      回到 V7.33.11 重做取字面板：位图渲染、挂监视窗子 View、
//            深色配色、探针与自愈守卫
// V7.35      框选截图后先 OCR，有字就弹同一个面板选词
// V7.36      两条路统一：只有面板里选中并点「复制」才产生文字结果
// V7.37      面板左下角加「单词/单字」切换（ICU 分词，不可用退回按字）
// V7.38      单字模式一汉字一块、不合并，装不下分页
// V7.39      两种模式都多选 + 拖动框选；单字模式默认全不选
// V7.40      两种模式都默认一个都不选；「清空/全选」按钮按需换字
// V7.41      面板期间跳过指针窗可见性自愈（否则箭头压在卡片上）
// V7.42      静音：关掉「启动中…」与截图已保存两条吐司
// V7.43      彻底静音：删掉所有吐司代码，只留「识别已就绪」；导入文件
//            五个 ShowToast 只留「识别已就绪」那一个
// V7.44      弹框即终点：面板弹出/已占位/截图已落盘之后，预热 OCR 完成
//            不再弹「识别已就绪」，也不再回填或发起新的 OCR
// V7.45      面板手势三态：按字拖=加选/反选（已选≥2 且按在已选块上取反），
//            按空白上下拖=翻页（上滑下一页，一次一页），阈值 10dp
// V7.46      去掉分页，改成**连续滚动**：所有块一次排完，空白处上下拖按
//            像素偏移滚动（拖字到上下边缘还会跟着滚），右侧画滚动条
// V7.47      滚动重绘零分配：双缓冲轮换 + 只重画文字区，帧间隔 60ms→16ms，
//            块文字/字宽在布局时缓存（不再每帧 substring + measureText）
// V7.48      取消选字面板「无操作 60s 自动关闭」：面板只能由用户显式结束
//            （复制/取消/点面板外/二指）；300s 全局看门狗在面板期停掉，
//            单实例残留判定改用 pid 存活
// V7.49      修：空白处上下拖滚动，右上角「已选 N 字」会自己涨。命中改为
//            按**文字实际宽度**判，块内留白算「卡片空白」（可用来起滚）
// V7.50      修：已选着字再滚动，计数在两个值之间跳。滚动帧沿用的备用位图
//            固定层比当前状态旧一代；改为给每张位图记固定层指纹，对不上
//            就整画一次
// V7.51      性能与收敛（行为不变）：块绘制批量化（每块 7 次跨 JNI → 2 次，
//            可见块二分定位）、探针日志攒批落盘（手势期零同步 IO）、
//            拖选索引用布局期行表、滚动节流 10ms（超 14ms 自动退避）、
//            选字节流 60ms
// V7.52      未选块文字加深：原来 #7C848E / #7A828C 与块底对比度只有 3.5，
//            在 17sp 下偏虚；改为 #A2AAB5 / #58606C，对比度 5.7，仍明显
//            低于已选块（浅底 + 高亮字），一眼能分出选没选
// V7.53      修：面板弹了却像没弹、随后每次都不再弹。两处：
//            ① close() 中途抛异常会跳过 CLOSE_DONE —— 自愈守卫下次就判
//               「上次崩了」，把面板功能整体关一轮（现象就是"截图后不弹"）。
//               整段改成 try/finally，CLOSE_DONE 必写并立即落盘
//            ② 守卫判据本身也不成立：V7.48 后面板可以一直开着，"没有
//               CLOSE_DONE"是正常状态。改为先看上次进程是否还活着，
//               再按 120s 窗口判（原 180s）
//            另：PANEL_GEOM 补面板绝对坐标与 host 尺寸（面板被摆到屏幕外时
//            shown 仍是 1，旧日志看不出来）；补两个静默出口的探针
// V7.54      截图到弹面板的等待瘦身（行为不变）：松手→截图的固定等待
//            120ms→48ms（够 3 帧让框选框隐掉，原来多等 5 帧）、OCR 完成→
//            弹面板 120ms→0（回调已在主线程空闲时跑，再等一轮是纯延迟）；
//            另补四段计时探针：AREA_T_READY（松手→开识别）、AREA_T_SHOT、
//            AREA_T_ENC、AREA_T_OCR，以及 PANEL_SHOWN 的 d/d0 —— 下次再看
//            「松手到看得见」就能直接看出时间花在哪一段
// V7.55      截图面板改版（只动截图模式，取字面板一字未变）：
//            ① 文字区下面加**截图缩略图**（按比例 contain，最多 150dp 高，
//               带圆角与描边；空间不够时自动缩小/隐藏，绝不挤掉文字区）
//            ② 底部按钮拆两行：上行「单词/单字 · 保存图片 · 分享」，
//               下行「清空 · 取消 · 复制」—— 原来一行放 6 个会挤成一片
//            ③ 新增两个出口：保存=只要图（不回传文字），分享=存图后拉起
//               系统分享面板；两者都走 data.areaAction，导入侧按它分流
// V7.56      截图面板收口（六处）：
//            ① 缩略图与文字区之间加 1dp 分割线（浅色 #D6DBE2 / 深色 #4A4F58），
//               两段内容不再连成一片
//            ② 按钮改回**一排**：词/字 · 分享 · 保存 · 取消 · 清空 · 复制。
//               按宽度自适应：先缩内边距，再降字号（14sp→10sp），最后等比压窄
//            ③ 缩略图不再透明：截图位图可能是 HARDWARE 配置，createScaledBitmap
//               缩出来还是 HARDWARE，软件 Canvas 画不上（旧版静默失败）。改为
//               画进一张 ARGB_8888 软位图，HARDWARE 源先 copy 再画
//            ④ 缩略图缩小到最多 108dp 高（原 180dp），把高度还给文字区
//            ⑤ **不按保存/分享就不落盘**：截图只写 ShortX 私有目录当临时文件，
//               复制/取消/点外面都会立刻删掉；只有 save/share 才交给导入侧搬进
//               DCIM/Screenshots 并扫库
//            ⑥ 模式按钮「单词模式/单字模式」合成一个「词/字」：当前那半边用
//               标题色加粗，另一半用次要色 —— 一行六个按钮才排得下
// V7.57      两处收尾：
//            ① 去掉缩略图下面那行「1170 × 1904 · 1.2 MB」。截图本身就在眼前，
//               尺寸/体积属于自证信息，白占 18dp 高度。整行连同它的高度一起
//               撤掉，缩略图下面直接就是按钮排
//            ② 分享真正调起系统分享面板。V7.56 的做法是在导入侧 ExecuteJS 里
//               自己 startActivity —— ShortX 的 JS 环境拿不到可用的 Context
//               （既没有 Activity，Application 上下文还要过 Android 10+ 的
//               后台启动限制），异常又被 catch 吞掉，于是「点了没反应」。
//               改由 shell 走 `am start`：root 直接调 AMS，不受后台启动限制，
//               也不受 StrictMode 的 file:// 拦截；uri 优先用 MediaStore 的
//               content://（轮询等媒体库索引），查不到再退 file://
// V7.58      分享提速（V7.57 点了要等 5~6 秒才弹框）：
//            `content` / `cmd` / `am` 都是 /system/bin 下的脚本，每次调用要
//            启一个 ART 进程（实测 250~500ms）。V7.57 的 while 最多跑 10 轮、
//            每轮 content query + cmd media_scanner，等于 20 次进程启动 ——
//            慢的根因就在这里，跟"媒体库索引慢"没关系。现在：扫库只做 1 次
//            且在循环外、查询最多 3 次（间隔 0.15s），搬图与分享并成同一条
//            shell（少一次 su + sh 启动）
// V7.61      落盘改 MediaStore 直写（相册不刷新的根因修复 + 再提速）：
//            V7.58 的分享是「mv 进 DCIM → 扫库 → 查 _id → am start」。图确实
//            躺进了 DCIM/Screenshots，但相册里始终不出现 —— 因为扫库那步用的
//            是 `cmd media_scanner scan-file`，Android 10+ 上多数 ROM 已经没
//            这个服务了，**命令不存在也不会报错**，扫了个寂寞。现在改由脚本
//            自己写 MediaStore：
//            ① insert 一行（RELATIVE_PATH=DCIM/Screenshots、IS_PENDING=1）
//            ② 把 png 字节写进 openOutputStream(uri)
//            ③ IS_PENDING=0 —— MediaProvider 落库并生成缩略图，相册**当场**
//               就有这张图（这是 Android 10+ 唯一可靠的"免权限写相册"路径）
//            ④ 顺手拿到 content:// uri 写进 .share_uri 交接口文件，导入侧
//               只剩一句 `am start`：分享从 4 次进程启动降到 1 次
//            任何一步失败都返回 null → 导入侧老链路原样兜底，绝不会"点了没反应"
// V7.61      分享不再绕 shell：既然分享的永远是图片，就没必要让一个外部进程
//            去问"图在哪、uri 是什么"再调 am。脚本自己（system_server，
//            uid=1000）直接 startActivityAsUser 拉起系统分享面板：
//            ① 零次外部进程 —— 原来 su + am 两次冷启动（300~600ms）全没了
//            ② 不再需要 handoff 里的"猜文件名 / 扫库 / 查 _id"兜底链
//            ③ 450ms 后自检一次 top activity：明确没弹起来才把 handoff 第 3
//               行改写成 f，交给导入侧 shell 的 am start 兜底
//            ④ 导入侧那条 shell 常态下只 sleep 0.55 后 exit —— 它退化成
//               "只在脚本自己弹不出来时才干活"的保险丝
// V7.61      分享分段计时（纯观测，不改行为）：
//            用户报"点分享要等 6 秒"，但 6 秒可能是三个完全不同的地方：
//              ① 落盘（写 png 字节进 MediaStore）
//              ② 脚本那次 startActivity 被拦，退回 shell 的 su + am
//              ③ 系统分享面板自己的冷启动（要 resolve 全部能收 image/png
//                 的 app 并加载图标，首次可能好几秒）
//            光看结果分不开，所以加四个时间戳，一条日志就能定位：
//              SHARE_T_PUBLISH  点击 → 落盘完成
//              SHARE_T_CLOSE    点击 → 面板关闭
//              SHARE_T_CALL     点击 → startActivity 返回（只是"发出去了"，
//                               不代表面板已经画出来）
//              SHARE_T_DONE     点击 → 交付完成
// V7.62      ① 修 V7.61 落盘必然失败：ContentValues.put(IS_PENDING, 1) 传的是
//               JS 数字，Rhino 按 Double 匹配到多个重载（Long/Integer/Byte/
//               Short/Float/Double），抛 "method ... is ambiguous"。insert 一
//               失败，publishAreaShot 就返回 null，分享立刻退回 shell 的
//               mv+扫库+am 三次冷启动 —— 这就是"点分享要等 6 秒"的真凶，
//               跟 V7.60/V7.61 的 startActivity 路线无关。改传
//               java.lang.Integer.valueOf(n)，精确匹配 put(String,Integer)。
//            ② 两处缓冲吐司（不承载状态，只为"让用户知道系统没死"）：
//               · 松手 → 「正在识别文字…」，选字面板出现即撤；
//               · 点分享 → 「正在分享中…」，分享面板占住 top activity 即撤。
//               复用同一个 Toast 实例 + 3.2s 续期，避免排队与漏弹；分享那条
//               每 300ms 查一次 top activity（脚本自己弹和 shell 兜底都适用）。
// V7.63      ① 修 V7.62 的致命作用域错（**这就是那次软重启**）：两条缓冲吐司
//               的实现在 IIFE 顶层，却引用了 startPointerTextToPickword 内部
//               的 nowMs / probeLog。strict 模式下取不到就是 ReferenceError，
//               而且它跑在 View.onTouch 的调用栈里 —— 异常穿过 JavaAdapter
//               进 InputDispatcher，system_server 直接被带走（crash log：
//               ReferenceError: "nowMs" is not defined，栈顶 showBusyToast
//               第 485 行、再上面是 finishAreaCapture）。现在整个吐司实现
//               搬进 startPointerTextToPickword，与调用点同作用域。
//            ② 吐司只调 ShortX 自带的 ShowToast 动作：不建实例、不续期、
//               不撤销。删掉 BUSY_TOAST/BUSY_KEEP_MS/armBusyKeepAlive/
//               watchShareToast 以及六处 hideBusyToast 调用点。
//            ③ onTouch 整体包 try/catch：任何 JS 异常都不许再冒进 Java 层。
//            ④ 导入侧「截图/分享」拆成三条独立的 shell（保存图 → 刷新图库 →
//               分享），与「截图/存图」同构，各自职责单一、可以单独重跑。
// V7.64      ① 落盘换路：V7.61~63 的 pending 流程在这台机器上 insert 成功、
//               open 必失败（FileNotFoundException: Failed opening content
//               provider），所以**落盘一次都没成功过** —— 分享只能靠导入侧
//               shell 兜底，而那条兜底只查一次库，扫库还没落库时就查不到，
//               于是表现为「有时候分享框根本不弹」。现在首选「java.io 直写
//               /sdcard/DCIM/Screenshots + 请 MediaProvider 扫一遍」，provider
//               流程降级为备胎（只有直写连文件都写不出来时才用）。
//            ② 导入侧 ③ 改成「查不到就扫一下再查」最多 4 轮，并把每一步
//               （enter / recheck / query / fallback / giveup / am1 / am2）
//               追加进 probe.log，am start 的返回码和输出也记下来。
// V7.65      分享改回 shell 发起（用户反馈：JS 版有时要卡一分钟才弹框）：
//            ① 删掉 shareViaSystem / probeShareShown / armShareGuard 整套。
//               startActivityAsUser 跑在 system_server 主线程，而调用链是从
//               View.onTouch 进来的 —— 同进程重入 ActivityTaskManager 会被
//               自己的锁堵住，表现为"点了半分钟没反应，然后突然弹出来"；
//               被 BAL 静默拦掉时连异常都没有，只能靠 top activity 猜。
//            ② 脚本只负责写交接口文件（uri / 文件名 / 标记 f），分享由导入侧
//               ③ 号 shell 的 `am start` 完成。独立进程 + binder，每次
//               1~2 秒、抖动小：慢一点，但每次都在同一个量级。
//            ③ 导入侧 ③ 去掉「mark=n 就 sleep 0.55 再读」这段等待 ——
//               既然脚本不再自己发，那个分支永远不会命中，白等 0.55s。
//            ④ 导入侧 ② 改成「有文件名就只扫那一张」：mv 之后要扫的图是
//               确定的（交接口文件第 2 行），不必再猜 ls -t 的前 3 张 ——
//               少两次 content call（每次 250~500ms），分享更快也更准。
// V7.66      只留一条路（用户：方式太多会互相冲突，反而更慢）：
//            ① 脚本**不再落盘**。删掉 publishShotByIo / publishShotUriByName /
//               publishShotByProvider / publishAreaShot 四个函数（约 200 行）。
//               这些是 V7.61~65 为解决"相册不刷新 / open 失败"叠出来的两套
//               机制；导入侧 shell 本来还有第三套（mv + 扫库 + 查 _id）。
//               三套同时存在，互相覆盖、互相抢 MediaProvider，延时忽长忽短。
//               现在脚本只留临时 png，落盘/刷库/分享全交给 shell。
//            ② 脚本**不再有任何吐司**。删掉 busyToast / busyToastSys /
//               busyToastLater / toastReadyNative / toastReadyAsync，以及
//               ShowToast 类的 importClass。「正在分享中…」移到指令链的
//               「显示吐司」动作；「识别已就绪」「正在识别文字…」删除
//               （后者由 panelNotice 承担，松手瞬间动作链还插不进来）。
//            ③ 分享只写一行文件名进交接口文件，不再传 uri（脚本已经不落盘）。
// V7.67      分享 UI 交给 ShortX 自带的「分享内容」动作（用户：看看能不能
//            用 ShortX 的动作弹分享，别再起 am 进程）：
//            ① 查了 ShortX 2.0 的 proto：ShareContent 这个动作就是为这件事
//               准备的 —— filePath + mimeType + text + chooserTitle，内部
//               自己构造 ACTION_SEND 并弹 chooser，跑在 ShortX 自己的进程里，
//               既不 su 也不 fork am。
//            ② 同时确认另外两条走不通，以后别再试：StartActivityIntent 的
//               extras 只有 Bool/Double/Float/Int/Long/String 六种标量，没有
//               Uri —— 塞不进 EXTRA_STREAM；它内层的 AndroidIntent 也没有
//               mimeType 字段。所以「启动活动」发不出一个合法的图片分享
//               Intent（目标 App 读 EXTRA_STREAM 会拿到 String 而崩溃）。
//            ③ 导入侧 ③ 从「查 _id + am start」缩成「echo 一个文件路径」：
//               查库轮询、am 三级退让、file:// 兜底全部删除。
//            ④ 脚本只把 data.shareShell 改名 data.shareAction（语义：这次
//               交付由动作链拉起分享），其余逻辑一字未动。
//
// V7.68      分享改回 shell 的 am start（V7.67 的 ShareContent 实测不弹）：
//            ① ShareContent 动作与脚本同进程（注入在 system_server），它弹
//               面板照样要在这个进程里 startActivity —— 同进程重入 ATMS
//               或被 BAL 拦掉，表现就是"什么都没发生"，与 V7.61 同因。
//            ② 导入侧 ③ 恢复「读文件名 → 查 _id（≤2 次、间隔 0.25s）→
//               am start 一次」：独立进程，稳定可弹。
//            ③ 导入侧 ② 只扫最新 1 张（原 3 张）：省两次 content call，
//               约 0.5~1s，而分享链总共才 1 秒出头。
//            ④ 脚本代码零改动，只改注释与版本号。
//
// V7.69      分享链的"执行体"搬出 ShellCommand，落到磁盘上的 run.sh：
//            V7.68 的分享动作是一条 1205 字符的 shell，实测在 ColorOS 16 上
//            **一句日志都没写就没了**（probe.log 停在 SHARE_T_HANDOFF，既没有
//            SHARE_SH bn=…，也没有任何报错）。同一台机器上 V7.67 那条 514
//            字符的命令能跑（只是晚了 121 秒才执行）。长度 / 嵌套引号 /
//            mksh 方言三者叠加，让"一条长命令"变成不可控变量。
//            ① 脚本在会话开始把执行体写成一个 .sh（约 40 行，纯双引号，
//               没有一处需要转义），导入侧只剩一句
//                 su -c 'sh <dir>/run.sh share'   （约 210 字符）
//            ② 执行体自己按段落打日志（RUN enter / mv_done / scan rc= /
//               bn= / id= / am rc= / done），每段带毫秒时间戳。下次再慢，
//               一眼看出是 shell 起晚了、扫库慢、还是 am 没弹。
//            ③ 存图分支同样只留一句：su -c 'sh <dir>/run.sh save' ——
//               与分享分支共用同一个执行体，差别只在最后要不要 am start。
//
// V7.70      分享**不再等指令链**（用户第四次反馈"依旧没有分享界面"）：
//            证据链：这次的 .share_uri 在分享 10 分钟后仍然存在，而 run.sh
//            第一件事就是 rm 掉它 —— 说明那条 shell 一次都没执行过。上一版
//            V7.67 的日志里它执行了，但时间戳是 CLOSE_DONE 之后 **121 秒**。
//            结论：ShortX 指令链的 shell 动作在 ColorOS 16 上既不保证执行、
//            也不保证及时，不能再当唯一通道。
//            ① 脚本在 share 分支自己 fork：Runtime.exec(["sh", run.sh,
//               "share"])，优先 /system/bin/su -c，失败退回直连 sh
//               （run.sh 内部会自我提权）。exec 只花十几毫秒，不阻塞触摸。
//            ② run.sh 变成幂等：以交接口里的文件名为键，先抢 mkdir 锁、
//               结束时落 done 标记 —— 脚本和指令链同时起，也只会 am 一次。
//            ③ 脚本尾部补 probeFlush：SHARE_T_DONE / AREA_DELIVER 以前被
//               12 条缓冲吞掉，导致"日志停在 HANDOFF"看不出脚本有没有返回。
//            ④ 指令链那条 shell 原样保留（193 字符），退化成兜底：脚本成功
//               时它跑起来会看到 done 标记，直接跳过。
//
// V7.71      「截图没有进相册」+「分享还是不弹」，日志给出了第一个硬结论：
//            SHARE_SPAWN ok=0 err su:…/system/bin/su error=2 No such file…
//                             sh:…/system/bin/sh error=13 Permission denied
//            —— 这台机器上脚本**根本不能 exec 任何程序**（su 不存在、sh 被
//            SELinux 拦）。前面三版一直以为"指令链的 shell 不执行"，其实
//            脚本自己那条也从来没执行成功过，日志里第一次说清楚。
//            ① 落盘改纯 Java：java.io 流复制到 /sdcard/DCIM/Screenshots，
//               三级路径回退（/sdcard → /storage/emulated/0 → /data/media/0）。
//               成功打 LAND ok=1，失败打 LAND_FAIL（带异常原文）。
//            ② 刷库改纯 Java：反射 MediaStore.scanFile（API 29+）→
//               MediaScannerConnection.scanFile → 旧版广播，三级回退，
//               打 SCAN ok=1 by=…。
//            ③ fork 的 su 路径补全：KernelSU /data/adb/ksu/bin/su、APatch
//               /data/adb/ap/bin/su、Magisk /data/adb/magisk/su —— 原版只试
//               /system/bin/su，而这台机器上它不存在。
//            ④ 指令链动作顺序调整：**shell 在前、吐司在后**。V7.66 起吐司
//               是第一条，而 V7.66 起 shell 就再没执行过 —— 顺序是最省事的
//               嫌疑，把吐司挪到最后，两者互不牵连。
//
// V7.72      回到最简单的结构（用户要求：分享分支 = 存图分支 + 一条弹分享
//            的 shell + 吐司，不要再搞新机制）：
//            ① 删掉 V7.69~V7.71 那三套：run.sh 执行体、脚本 fork、脚本内
//               java.io 落盘。它们一次都没在真机上成功过，反而每次都在
//               引入新变量。
//            ② 指令链恢复成三段**各自独立、各自很短**的命令：
//                 su -c 'mkdir -p …; mv -f <shortx>/*.png …'        (~140 字符)
//                 su -c 'for f in $(ls -t … | head -1); do content call …'  (~150)
//                 su -c 'ID=$(content query … --sort "date_added DESC" …); am start …'
//               V7.63~V7.67 用的就是这种形状，那几版图确实进了相册。
//            ③ 弹分享只用一条标准 intent，不查 where、不拼文件名：
//               am start -a android.intent.action.SEND -t image/png
//                        --eu android.intent.extra.STREAM content://media/external/images/media/<id>
//                        --grant-read-uri-permission
//               _id 用 content query --sort "date_added DESC" 取最新一张，
//               与第 ② 步 scan 的那张是同一张，不需要匹配文件名。
//            ④ 存图分支只有 ①②，分享分支是 ①②③ + 吐司 —— 两条链路前面
//               逐字节相同，分享只多一步"把刚存好的图 SEND 出去"。
//
// V7.73      只改「分享」那一刀，别的一行不动（用户自己验证过命令）：
//            ① am 换成用户终端模拟器里实测能秒弹分享面板的那条：
//                 su -c am start -a android.intent.action.SEND -t "image/*"
//                        --eu android.intent.extra.STREAM "file://<路径>"
//                        --grant-read-uri-permission
//               去掉 content query 查 _id、去掉 while 重试、去掉 grep/sed——
//               那条 635 字符的命令从 V7.63 到 V7.72 一次都没跑成过。
//               路径用 ls -t | head -1 取刚搬进 DCIM 的那张（mv 保留 mtime，
//               最新一张就是这次截的）。
//            ② 动作顺序：**吐司提到第一条**，再跑 mv / scan / am。
//               V7.72 把吐司放最后，用户看不到任何"我点到了"的反馈。
//            ③ mv / scan 两条与存图分支仍然逐字节相同 —— 分享链路前半段
//               就是存图链路，只是最后多一条 am。
//
// V7.74      确认分享能弹出后做减法（用户：删掉没在用的节点、提示、判断）：
//            ① 导入侧「失败/错误」分支整块删除。它那个 ExecuteJS 只是把
//               message/code 拼成 pointerErrorText，绑完没有任何动作读它 ——
//               纯空转。删掉后出错时 SwitchCase 无分支命中，静默结束。
//            ② 脚本删 .share_uri 交接口（变量 + 写函数 + 调用 + 日志）。
//               V7.72 起 shell 用 ls -t 取最新一张，这个文件早没人读了。
//            ③ 交付 JSON 从 7 个字段减到 5 个：visualRect / captureRect /
//               pickedText / cancel / areaAction。name / mime / sizeBytes /
//               shareAction 全链路无人读，连 name 那次 getName()、sizeBytes
//               那次 length() 一起省掉。
//            ④ 删 panelNotice("面板已挂上但不可见…")：probe 的 PANEL_GEOM
//               已经记了 w/h/shown/at/screenOff，屏幕上不需要再念一遍。
//            ⑤ 删 hitRadius（定义了从没读过）。
//
// V7.75      两处小改（用户提的界面手感 + 文案）：
//            ① 面板里的「复制」按钮改成**有选中才亮**：acc = (k=="copy") && anyOn。
//               没选字时它和「取消 / 清空」同款灰底灰字，选中任意一块才变
//               蓝底白字加粗。原来它恒为强调色，用户以为一直可点，实际点
//               下去 joinPickSegments 返回空、只打一行 PANEL_COPY_EMPTY 就
//               静默返回 —— 现在按钮状态和真实可点性一致。
//               选中态一变 fixedSig() 就变，redraw 会自动整画，颜色立刻跟上。
//            ② 导入侧「截图/分享」第一条吐司文案「正在分享中…」→「正在分享」。
//
// V7.77      **母版退回 V7.75**（用户要求：以 7.75 为准），只做「截图模式」
//            的性能优化。导入侧一个字没动 —— 指令链仍是 V7.75 那四条分支。
//            ① 框选框只脏「旧框 ∪ 新框」，不再每帧整屏 invalidate。
//               旧实现 showAreaFrame() 每帧 view.invalidate() 无参：一个
//               1080x2400 的 overlay 层，60fps = 每秒整屏重画 60 次，而框
//               只占其中几条边。现在两次带参 postInvalidateOnAnimation：
//               一次擦旧框、一次画新框；手指没跨过一个像素就整帧跳过。
//               首帧（或刚从 INVISIBLE 复位）仍整屏来一帧 —— 那时层里内容
//               不确定，宁可多画一次也不留残影。
//            ② onDraw 零分配：读 showAreaFrame 写好的 areaDrawnRect，不再
//               每帧调 getAreaVisualRect() 造 {left,top,...} 对象；描边宽
//               用 areaStrokeW（build 时算好的 dp(2)），不再每帧 dp(2)。
//            ③ MOVE 热路径：比距离用平方（去掉每帧一次 Math.sqrt）；框选
//               终点就地算成两个数，不再经 hotspotFromPointerXY 造临时对象。
//            ④ 空闲计时器复用同一个 Runnable：拖动中每次重置不再 new
//               JavaAdapter（解释器里造对象不便宜）。
//            ⑤ 全部 (new Date()).getTime() → nowMs()（System.currentTimeMillis）。
//               Date 是 JS 对象，热路径上每帧建一个纯属白给。
//            ⑥ 截图通路做成表 + 记忆上次成功的那条：Android 14/15 上如果
//               第一条 parcel 通路失败，旧代码每张图都要先构造十几个 Rhino
//               异常（异常在解释器里很贵）。现在成功过的通路排到最前。
//            ⑦ 截图位图只 readback 一次：捕获回来是 HARDWARE（GPU 显存），
//               旧流程里 compress() 内部读一遍、buildAreaThumb() 里
//               drawBitmap 到软件 Canvas 失败后又 copy 一遍。现在先 copy 成
//               ARGB_8888，编码与缩略图共用，末尾 recycle；copy 失败原路返回。
//            以上都不改任何对外行为：交付 JSON、面板、指令链、日志字段不变
//            （只有 AREA_T_SHOT 多一个 m=<通路下标>）。
//
// V7.78      面板「装得更多」：只动选字面板的字号与块间距，行为、结构、
//            指令链一处没改。
//            ① 词块 17→15sp、块高 30→27dp、块间距 5→3dp、块内左右留白
//               14→11dp。单块占位从 36×35dp 缩到 29×30dp —— 内宽 329dp
//               的文字区每行从 9 块变 11 块，行数多出 17%，同样的视口高度
//               能排下的字约多四成。
//            ② 按钮 14→12sp。六个按钮挤在内宽 400dp 上下时的三步兜底
//               （缩内边距 → 降字号 → 等比压窄）原样保留，只是字号小了以后
//               很少再被压到「内边距 12dp + 10sp」那种极限状态。
//            ③ 标题/提示/计数（15/11sp）、按钮高度 34dp、面板宽度、滚动、
//               命中判定全不变 —— 命中用的矩形就是 layoutFor() 排好的块
//               矩形，块小了矩形跟着小，不用另改一处。
//
// V7.79      面板再挤一档：只动「块的外框」和「文字区到分隔线的距离」，
//            字号 15sp 一个没动（要的是框小，不是字小）。
//            ① 块内左右留白 11→8dp、块高 27→25dp、块间距 3→2dp、圆角 7→6dp。
//               单块占位 29×30dp → 24×27dp：15sp 的字在 25dp 高的框里上下
//               各留 5dp，仍看得出是「一块」，但一行的块数从 15 涨到 17。
//            ② 文字区底到分隔线 14→9dp、分隔线上留白 12→8dp、下留白 10→8dp。
//               这三处一共让出 9dp，全部还给文字区。
//            ③ 于是同屏行数 14→16。1280×2800 / 2.75 实测：首屏可见字数
//               210 → 282（+34%），词模式 8×6=48 块 → 9×7=63 块。
//            ④ 面板高度上限 68% 屏高、按钮高度 34dp、命中判定、滚动、
//               指令链、交付 JSON 全不变。
//
// V7.80      「词」模式终于是一个词一块 —— 之前它把相邻的词粘成了 7 个字。
//            ① 根因是 V7.37 的「块数上限 40」：ICU 本来就把词切好了
//               （是/全球/用户/广泛/使用/的/下载/管理/工具/…），buildAll 再按
//               ceil(n/40) 把 4 个相邻词合成一块 —— 40 个块 = 每块 4 个词
//               ≈ 7 个字，看上去就是"按字数硬截断"，用户反馈的正是这个。
//            ② 删掉 mergeSegments / selectPanelMaxChips / PANEL_RECHUNK：
//               切出多少块就排多少块。V7.46 起文字区本来就能滚，绘制只画
//               视口内的块、命中走行表二分，块数不进每帧成本。
//            ③ splitPickWords 补一道保护：单个块最长 12 字。ICU 词典缺失的
//               ROM 会把整句当一个 span，那种块点一下就是全选；超长的先按
//               标点切、再等分，正常分词（1~4 字/块）走不到这段。
//            ④ 新增 PANEL_SEG 探针（src=icu|char chips=n）：万一某台机器
//               分词退化成按字，日志里一眼能看到。
//            ⑤ 面板尺寸、字号、命中判定、滚动、指令链、交付 JSON 全不变。
// ============================================================
var ShortXPointerActiveRef = null;

// V7.33.5：后台查询自检结论缓存（0=未验证 1=可用
// 2=不可用）——自检要跑 2~4 次全树查询（每次数百 IPC），旧实现每次运行
// 都跑一遍，恰好与用户第一次拖动、OCR 预热抢资源。引擎复用作用域时跨
// 执行持久；若每次新建作用域则退化为每进程一次，可接受。
var ShortXPointerBgState = 0;

(function() {
    'use strict';
    var PointerResult = {
      done: false,
      json: "",
      latch: new java.util.concurrent.CountDownLatch(1)
    };
    // V7.13：全局收尾看门狗 + 指针运行时引用（供看门狗强制收尾时关闭指针，
    // 详见文件尾部创建处；pointerRuntime 本身是函数局部变量，够不到外层）
    var GlobalWatchdog = null;
    var PointerRuntimeRef = null;
    // V7.48：面板停留看护（替代已删的「面板 60s 无操作自动取消」）。
    // 它不是「到点收菜单」，而是「会话挂死的最后一道闸」：面板一旦弹出就
    // 撤掉 300s 全局看门狗，改由本 Timer 在 selectPanelHoldMs 后收尾。
    // 默认 30 分钟 —— 正常读字/挑词永远碰不到；设 0 则连这道闸也关掉。
    var PanelHoldWatch = null;
    function cancelPanelHold() {
      try { if (PanelHoldWatch) { PanelHoldWatch.cancel(); PanelHoldWatch = null; } }
      catch(ePH0) { PanelHoldWatch = null; }
    }
    // V7.33.5：本次执行是否成功占用单实例标志。
    // 拒绝路径（层 1/层 2 拦截）绝不能释放或清空别人的会话——旧实现
    // 拒绝后仍走尾部 releasePointerActive()，会误删在跑会话的标志。
    var pointerClaimed = false;
    // V7.33.5：IIFE 级 app 引用——旧实现 app 是
    // startPointerTextToPickword 的局部变量，finishWithJson（外层作用域）
    // 读不到：严格模式下 `if (app && ...)` 抛 ReferenceError，被外层
    // catch 吞掉 → 依赖 app 的收尾逻辑整段静默失效。改为外层声明 +
    // 内层赋值。
    var app = null;

    // ===== V7.33.4：重复运行防护——单实例标志 =====
    // 背景：用户不小心重复触发运行入口（误按/连点）时两个指针会话
    // 并存，各建一个悬浮窗箭头 → 屏幕上出现两个箭头，取字/取消相互
    // 干扰。防护分两层：
    //   层 1：IIFE 外顶层 ShortXPointerActiveRef——ShortX 若复用同一
    //     JS 引擎/全局作用域重复执行本脚本，该变量跨执行持久，前一
    //     会话 closed=false 即拒绝第二次（主流程处判定）；
    //   层 2：私有目录标志文件 <shortx>/data/screenshots/.pointer_active
    //     ——跨作用域兜底（引擎每次新建作用域时层 1 失效）；与 OCR 输入
    //     截图同目录（V7.31 已证可写），点前缀文件不会被「截图/ocr」
    //     case 的 mv data/screenshots/ 下所有 png 搬进相册；
    //   stale：V7.48 起面板没有超时，一次会话可以停很久（读字、挑词），
    //     所以**年龄不能单独当判据**。硬判据换成「记录里的 pid 还活着且
    //     就是本进程」：本进程的会话永不过期；pid 已不存在（system_server
    //     重启过）说明是上次崩溃的残留，立刻放行。年龄只用于 pid 读不到
    //     的旧格式记录（300s 与全局看门狗同寿命）。全程 try/catch——IO
    //     失败降级放行（防护失效但不阻塞正常使用）。
    var POINTER_ACTIVE_STALE_MS = 300000;
    // 记录里的 pid 仍存活时用的上限：面板无超时后一次会话可以停很久，
    // 30 分钟足够覆盖任何人工停留；超过就按「同进程内的崩溃残留」处理。
    var POINTER_ACTIVE_LIVE_MS = 1800000;
    function pointerActiveFlag() {
      var base = "";
      try {
        if (typeof shortx !== "undefined" && shortx && shortx.getShortXDir) {
          base = String(shortx.getShortXDir());
        }
      } catch(e0) {}
      if (!base) return null;
      return new java.io.File(base + "/data/screenshots/.pointer_active");
    }
    // V7.33.5：标志文件内容 = pid + 写入时的开机内
    // 时间戳（elapsedRealtime）。读取失败/旧格式（无字段）时返回 0，调用方
    // 退回年龄判定，与 V7.33.4 行为一致。
    function pointerFlagRecord(f) {
      var rec = { pid: 0, elapsed: 0 };
      try {
        var br = new java.io.BufferedReader(new java.io.FileReader(f));
        try {
          var l1 = String(br.readLine() || "");
          var l2 = String(br.readLine() || "");
          var m1 = /pid\s*=\s*(\d+)/.exec(l1);
          var m2 = /elapsed\s*=\s*(\d+)/.exec(l2);
          if (m1) rec.pid = Number(m1[1]) || 0;
          if (m2) rec.elapsed = Number(m2[1]) || 0;
        } finally { try { br.close(); } catch(eCl) {} }
      } catch(eRd) {}
      return rec;
    }
    function pointerElapsedNow() {
      try { return Number(android.os.SystemClock.elapsedRealtime()) || 0; } catch(eEl) { return 0; }
    }
    function claimPointerActive() {
      try {
        var f = pointerActiveFlag();
        if (!f) return true; // 取不到私有目录：降级放行
        var nowElapsed = pointerElapsedNow();
        if (f.exists()) {
          var age = nowMs() - f.lastModified();
          var rec = pointerFlagRecord(f);
          // 开机批次判定：elapsedRealtime 自本次开机起算，记录值若明显大于
          // 当前值，说明那是上一次开机的会话（重启过）→ 必为残留，立即清。
          // 旧实现只看文件年龄，重启后 300s 内的第一次运行会被误判为
          // 「上一会话仍在」而拒绝（随后又因拒绝不收尾而卡满 300s）。
          var rebooted = rec.elapsed > 0 && nowElapsed > 0 &&
                         rec.elapsed > nowElapsed + 1000;
          // V7.48：pid 存活判定。本进程（system_server）的会话不因 300s 年龄
          // 过期（面板可以停很久）；记录里的 pid 在 /proc 下不存在 → 上一会话
          // 随进程一起没了，残留，立即放行。同一进程内脚本崩掉时 pid 仍在，
          // 用 30 分钟兜住（够长的人工停留都算活动会话，再久按残留处理）。
          var pidAlive = false;
          if (rec.pid > 0) {
            try { pidAlive = new java.io.File("/proc/" + rec.pid).exists(); } catch(ePidA) { pidAlive = false; }
          }
          var liveMs = pidAlive ? POINTER_ACTIVE_LIVE_MS : POINTER_ACTIVE_STALE_MS;
          if (!rebooted && age < liveMs) {
            return false; // 前一会话仍在进行（含长停留）
          }
          try { f.delete(); } catch(eDel) {} // stale 残留：清除后放行
        }
        var dir = f.getParentFile();
        if (dir && !dir.exists()) { try { dir.mkdirs(); } catch(eMk) {} }
        f.createNewFile();
        // 写入本次归属信息（失败不影响防护：退回年龄判定）
        try {
          var myPid = 0;
          try { myPid = Number(android.os.Process.myPid()) || 0; } catch(ePid) {}
          var fos = new java.io.FileOutputStream(f);
          try {
            fos.write(new java.lang.String("pid=" + myPid + "\nelapsed=" + nowElapsed + "\n").getBytes("UTF-8"));
          } finally { try { fos.close(); } catch(eFc) {} }
        } catch(eWr) {}
        return true;
      } catch(e1) { return true; }
    }
    function releasePointerActive() {
      try {
        var f = pointerActiveFlag();
        if (f && f.exists()) { try { f.delete(); } catch(eDel2) {} }
      } catch(e2) {}
    }

    // ===== V7.21：OCR 兜底通道类加载（diag-3 实证可用） =====
    // importClass 走 ShortX 脚本引擎自身的类加载器——指令链 case[3] 与
    // V7.21-diag-3 均实证可用（此前 V7.20 诊断用 Class.forName 反射失败，
    // 是 ShortX proto 类在动态类加载器里，forName 用系统 loader 找不到）。
    // 逐个 try：任一失败仅禁用 OCR 兜底，a11y 主通道不受影响。
    var HAS_OCR_DETECT = false, HAS_OCR_RECTSRC = false, HAS_OCR_ANY = false, HAS_OCR_OUTPUTTYPE = false;
    try { importClass(Packages.tornaco.apps.shortx.core.proto.action.OcrDetect); HAS_OCR_DETECT = true; } catch(eImpOcr1) {}
    try { importClass(Packages.tornaco.apps.shortx.core.proto.common.RectSourcePath); HAS_OCR_RECTSRC = true; } catch(eImpOcr2) {}
    try { importClass(com.google.protobuf.Any); HAS_OCR_ANY = true; } catch(eImpOcr3) {}
    try { importClass(Packages.tornaco.apps.shortx.core.proto.action.OcrDetectOutputType); HAS_OCR_OUTPUTTYPE = true; } catch(eImpOcr4) {}
    function safeString(v) {
      try { return v === null || v === undefined ? "" : String(v); } catch(e) { return ""; }
    }

    function safeJsonStringify(obj) {
      try {
        return JSON.stringify(obj);
      } catch(e0) {
        try {
          return JSON.stringify({
            ok: false,
            type: "pointer_error",
            code: "POINTER_ERROR",
            message: "指针异常",
            value: "",
            data: {
              error: safeString(e0.message || e0)
            }
          });
        } catch(e1) {
          return '{"ok":false,"type":"pointer_error","code":"POINTER_ERROR","message":"指针异常","value":"","data":{"error":"JSON stringify failed"}}';
        }
      }
    }

    function normalizeType(type) {
      type = safeString(type || "");
      if (type === "text_pick") return "text_pick";
      if (type === "area_capture") return "area_capture";
      if (type === "cancel") return "cancel";
      return "pointer_error";
    }

    function makeResult(ok, type, code, message, value, data) {
      return {
        ok: ok === true,
        type: normalizeType(type),
        code: safeString(code || (ok === true ? "OK" : "POINTER_ERROR")),
        message: safeString(message || ""),
        value: value === null || value === undefined ? "" : safeString(value),
        data: data || {}
      };
    }

    function finishWithJson(obj) {
      if (PointerResult.done) return;
      PointerResult.done = true;

      if (!obj) {
        obj = makeResult(false, "pointer_error", "POINTER_ERROR", "指针异常", "", {
          error: "空结果"
        });
      } else {
        obj = makeResult(
          obj.ok === true,
          obj.type || obj.action || "pointer_error",
          obj.code || "",
          obj.message || "",
          obj.value === undefined || obj.value === null ? "" : obj.value,
          obj.data || {}
        );
      }

      // V7.51：收尾前把攒着的探针日志全部落盘 —— 异常路径最需要它
      try { probeLog("SESSION_END " + String(obj && obj.code || "")); } catch(eSe) {}
      try { probeFlush(); } catch(ePfs) {}
      PointerResult.json = safeJsonStringify(obj);
      try { PointerResult.latch.countDown(); } catch(e) {}
      // V7.13：正常收尾时取消全局看门狗，避免 Timer 泄漏
      try { if (GlobalWatchdog) { GlobalWatchdog.cancel(); GlobalWatchdog = null; } } catch(eWd) {}
      // V7.48：面板停留看护同理，任何收尾路径都不许留 Timer
      cancelPanelHold();
    }

    function finishError(action, code, message, extra) {
      action = normalizeType(action || "pointer_error");

      var type = action;
      var msg = "指针异常";
      if (type === "text_pick") msg = "取字失败";
      else if (type === "area_capture") msg = "框选截图失败";
      else type = "pointer_error";

      // V7.13：extra 可带 stage 等诊断字段（ES5 无 Object.assign，手动合并）
      var data = { error: safeString(message || msg) };
      if (extra) {
        try {
          for (var ek in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, ek)) data[ek] = extra[ek];
          }
        } catch(eExtra) {}
      }
      finishWithJson(makeResult(false, type, safeString(code || "POINTER_ERROR"), msg, "", data));
    }

    // V7.43：取消不再弹「用户取消」——静默收尾。导入侧取消 case 只负责
    // 什么都不做，两条链路都不再产生任何提示。
    // 幂等守卫保留：UP / CANCEL / 多指退出 / close 多条路径可能先后到达，
    // 重复 countDown 会破坏 PointerResult 的收尾语义。
    function finishCancel(message) {
      if (PointerResult.done) return;
      finishWithJson(makeResult(false, "cancel", "USER_CANCEL", "用户取消", "", {}));
    }

    function pointToJson(x, y) {
      return {
        x: Math.round(Number(x || 0)),
        y: Math.round(Number(y || 0))
      };
    }

    function rectToJson(rect) {
      if (!rect) return null;
      var l = Math.round(Number(rect.left || 0));
      var t = Math.round(Number(rect.top || 0));
      var r = Math.round(Number(rect.right || 0));
      var b = Math.round(Number(rect.bottom || 0));
      return {
        left: l,
        top: t,
        right: r,
        bottom: b,
        width: Math.max(0, r - l),
        height: Math.max(0, b - t)
      };
    }

    function rectObjToJson(rect) {
      return rectToJson(rect);
    }


function startPointerTextToPickword() {
    // ==========================================
    // 指针核心：拖动指针命中控件文本，或悬停1.5秒进入框选截图，最终返回简洁 JSON
    // ==========================================
    // ShortX JS 原型 v2：fooview 风格指针 + 控件方框
    // 能力：拖动指针；以指针尖端为命中坐标；实时获取控件文字；绘制命中控件 bounds 方框
    // 参考：/storage/emulated/0/Download/ShortX-控件检索器.txt 的 getBounds / findClosestNode / showFrameAtRect 思路
    // Rhino ES5

    var pointerRuntime = null;

    function runOnMainSync(fn, timeoutMs) {
      try {
        var ml = android.os.Looper.getMainLooper();
        var my = android.os.Looper.myLooper();
        if (ml !== null && my !== null && ml === my) return { ok: true, value: fn() };
      } catch(e) {}
      var box = { ok: false, value: null, error: null };
      var latch = new java.util.concurrent.CountDownLatch(1);
      var h = new android.os.Handler(android.os.Looper.getMainLooper());
      h.post(new java.lang.Runnable({ run: function() {
        try { box.value = fn(); box.ok = true; } catch(er) { box.error = er; }
        finally { latch.countDown(); }
      }}));
      var done = latch["await"](timeoutMs || 5000, java.util.concurrent.TimeUnit.MILLISECONDS);
      if (!done) return { ok: false, error: "timeout" };
      if (!box.ok) return { ok: false, error: box.error };
      return box;
    }

    var _density = 1;
    try { _density = context.getResources().getDisplayMetrics().density; } catch(e) {}
    // V7.33.5：密度兜底——开机阶段 DisplayMetrics 可能
    // 整体返回 0，density=0 会让 dp() 全返 0（指针窗 0×0、pickLocal 0、
    // clamp 区间退化成点）。2.75 为主流竖屏密度中值，最坏是箭头略小。
    if (!(_density > 0) || !isFinite(_density)) _density = 2.75;
    function dp(v) { return Math.round(Number(v) * _density); }

    // V7.33.5：屏幕指标净化——任一级读到合法尺寸即
    // 采用；全部失败回落保守默认 1080×2340（主流竖屏中值，箭头至少落在
    // 屏内）。纯函数，便于单测。
    function sanitizeScreenMetrics(dm, real, cwm) {
      if (dm && Number(dm.w) > 0 && Number(dm.h) > 0) {
        return { w: Number(dm.w), h: Number(dm.h) };
      }
      if (real && Number(real.w) > 0 && Number(real.h) > 0) {
        return { w: Number(real.w), h: Number(real.h) };
      }
      if (cwm && Number(cwm.w) > 0 && Number(cwm.h) > 0) {
        return { w: Number(cwm.w), h: Number(cwm.h) };
      }
      return { w: 1080, h: 2340 };
    }
    function jint(v) { v = Number(v); if (v > 2147483647) v = v - 4294967296; return new java.lang.Integer(v); }

    // ===== V7.34：崩溃定位探针 =====
    // 脚本在 system_server 进程里跑，一旦有未捕获异常就是整机软重启，内存现场
    // 全丢，能留下的证据只有「崩溃前走到哪一步」。所以松手路径的每个节点都同步
    // 追加一行到文件（flush + close，进程被杀也不丢）。关闭方式：probe: false。
    var PROBE_ON = true;
    var probePathCache = "";
    var probeCandCache = null;
    // V7.51：日志攒批。原来每条日志一次 open/write/close —— 边缘拖选时
    // 每个 MOVE 都写盘，主线程被文件 IO 拖出白帧，手感就是"一顿一顿"。
    // 现在先进内存，攒够 12 条或 2KB 才落盘一次；正常滚动期间一次 IO 都没有。
    var probeBuf = [];
    var probeBufBytes = 0;
    function probeCandidates() {
      if (probeCandCache) return probeCandCache;
      var arr = [];
      var name = "屏幕取字_probe.log";
      try { arr.push(new java.io.File("/storage/emulated/0/Download/" + name)); } catch(e0) {}
      try { arr.push(new java.io.File("/sdcard/Download/" + name)); } catch(e1) {}
      try {
        if (typeof shortx !== "undefined" && shortx && shortx.getShortXDir) {
          arr.push(new java.io.File(String(shortx.getShortXDir()) + "/data/screenshots/" + name));
        }
      } catch(e2) {}
      probeCandCache = arr;
      return arr;
    }
    function probeLog(tag) {
      if (!PROBE_ON) return;
      try {
        var t = String(tag);
        var ms = 0;
        try { ms = java.lang.System.currentTimeMillis(); } catch(eMs) { ms = (new Date()).getTime(); }
        probeBuf.push(ms + " " + t);
        probeBufBytes += t.length + 16;
        if (probeBuf.length >= 12 || probeBufBytes >= 2048) probeFlush();
      } catch(eP) {}
    }
    // 落盘一次（整批）。任何"马上就要读日志"或"会话要结束"的地方都该先调它。
    function probeFlush() {
      if (!probeBuf.length) return;
      var lines = probeBuf;
      probeBuf = [];
      probeBufBytes = 0;
      try {
        var list = probeCandidates();
        var txt = "";
        for (var i = 0; i < lines.length; i++) txt += lines[i] + "\n";
        var bytes = null;
        for (var k = 0; k < list.length; k++) {
          try {
            var f = (probePathCache ? new java.io.File(probePathCache) : list[k]);
            var dir = f.getParentFile();
            if (dir && !dir.exists()) { try { dir.mkdirs(); } catch(eMk) {} }
            if (!bytes) bytes = new java.lang.String(txt).getBytes("UTF-8");
            var out = new java.io.FileOutputStream(f, true);
            try {
              out.write(bytes);
              out.flush();
            } finally { try { out.close(); } catch(eC) {} }
            probePathCache = String(f.getAbsolutePath());
            return;
          } catch(eW) { probePathCache = ""; }
        }
      } catch(ePF) {}
    }
    function probeTail(maxBytes) {
      try { probeFlush(); } catch(ePF0) {}
      try {
        var f = null;
        if (probePathCache) { try { f = new java.io.File(probePathCache); } catch(e0) { f = null; } }
        if (!f || !f.exists()) {
          f = null;
          var cands = probeCandidates();
          for (var i = 0; i < cands.length; i++) {
            if (cands[i] && cands[i].exists()) { f = cands[i]; break; }
          }
        }
        if (!f) return "";
        var len = Number(f.length());
        if (!(len > 0)) return "";
        var n = Math.min(len, maxBytes || 8192);
        var start = len - n;
        var fis = new java.io.FileInputStream(f);
        try {
          var skipped = 0;
          while (skipped < start) {
            var step = fis.skip(start - skipped);
            if (!(step > 0)) break;
            skipped += step;
          }
          var buf = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, n);
          var read = fis.read(buf);
          if (!(read > 0)) return "";
          return String(new java.lang.String(buf, 0, read, "UTF-8"));
        } finally { try { fis.close(); } catch(eC) {} }
      } catch(e) { return ""; }
    }
    function probeRotateIfBig(limitBytes) {
      try {
        var f = new java.io.File(probePathCache || String(probeCandidates()[0].getAbsolutePath()));
        if (f && f.exists() && Number(f.length()) > (limitBytes || 262144)) {
          var fo = new java.io.FileOutputStream(f, false);
          try { fo.write(new java.lang.String("").getBytes("UTF-8")); fo.flush(); } finally { try { fo.close(); } catch(eC2) {} }
        }
      } catch(e) {}
    }
    // V7.43：面板没弹/没起来只写 probe.log，不再弹 Toast。
    // 排查时看 Download/屏幕取字_probe.log 里的 PANEL_NOTICE 行。
    // V7.54：分段计时用。宿主是 Xposed 注入的 system_server，Date 由引擎
    // 提供，个别版本上被替换过；能拿到系统时钟就用系统时钟。
    function nowMs() {
      try { return java.lang.System.currentTimeMillis(); } catch(eNow) { return (new Date()).getTime(); }
    }
    function panelNotice(msg) {
      try { probeLog("PANEL_NOTICE " + msg); } catch(eN1) {}
    }

    // 上一次会话是否"排过面板、但没有正常收尾"（被系统带走时写不到 CLOSE_DONE）
    function probeLastPanelCrashed() {
      var tail = probeTail(16384);
      if (!tail) return false;
      var lines = String(tail).split("\n");
      var last = -1;
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf("===== SESSION") >= 0) last = i;
      }
      if (last < 0) return false;
      var sessLine = lines[last];
      var myVer = "v" + CUR_VER;
      if (sessLine.indexOf(myVer) < 0) {
        try { probeLog("GUARD_SKIP other_version"); } catch(eGs) {}
        return false;
      }
      var shown = false, ended = false, lastTs = 0;
      for (var j = last + 1; j < lines.length; j++) {
        var ln = lines[j];
        if (!ln) continue;
        var sp = ln.indexOf(" ");
        if (sp > 0) {
          var ts = Number(ln.substring(0, sp));
          if (!isNaN(ts) && ts > lastTs) lastTs = ts;
        }
        if (ln.indexOf("PANEL_POST") >= 0) shown = true;
        if (ln.indexOf("CLOSE_DONE") >= 0) ended = true;
      }
      if (!(shown && !ended)) return false;
      // V7.53：先看上次那个进程还在不在。
      // V7.48 起面板可以一直开着（不再有 60s 无操作自动关），"面板开着"的
      // 会话天然写不到 CLOSE_DONE —— 旧判据把这种正常状态当成崩溃，下一次
      // 运行直接把整个面板功能关掉一轮，用户看到的就是「截图后不弹选字框」。
      // 进程还活着 = 那次会话只是没结束，不是崩了。
      var pidM = /pid=(\d+)/.exec(sessLine);
      if (pidM && pidM[1] !== "0") {
        var pidAlive = false;
        try { pidAlive = new java.io.File("/proc/" + pidM[1]).exists(); } catch(ePa) { pidAlive = false; }
        if (pidAlive) {
          try { probeLog("GUARD_SKIP alive pid=" + pidM[1]); } catch(eGa) {}
          return false;
        }
      }
      // 真崩溃（system_server 被带走）会紧跟着重跑；隔太久就不是连崩，
      // 不值得为它牺牲下一次的面板。V7.53：180s → 120s。
      if (lastTs > 0 && (nowMs() - lastTs) > 120000) {
        try { probeLog("GUARD_SKIP stale"); } catch(eGs2) {}
        return false;
      }
      return true;
    }
    function grabSystemCrashLog() {
      try {
        var argv = java.lang.reflect.Array.newInstance(java.lang.String, 3);
        argv[0] = "su";
        argv[1] = "-c";
        argv[2] = "logcat -b crash -d -t 400 > /sdcard/Download/屏幕取字_crash.txt";
        var p = java.lang.Runtime.getRuntime().exec(argv);
        return !!p;
      } catch(e) { return false; }
    }

    // ===== V7.34：选择面板的分词与拼接（纯函数，便于单测）=====
    // 默认按「单字」切块：中文没有分词词典，按 2 字硬切会把「信用卡还款」
    // 切成 信用|卡还|款（跨词，选不全也选不对）；单字切块永远正确（V7.40
    // 起默认不选，按需点取）。
    // 拉丁字母/数字按 token 切；标点并入前一块；空白不进块。
    function splitPickSegments(text, chunk) {
      var out = [];
      var s = String(text || "");
      var n = s.length;
      var i = 0;
      var step = Math.max(1, Math.min(4, Math.round(Number(chunk) || 1)));
      function isCJK(code) {
        return (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) ||
               (code >= 0xF900 && code <= 0xFAFF);
      }
      function isWordChar(c) {
        return /[0-9A-Za-z_@.\-%+\/]/.test(c);
      }
      while (i < n) {
        var c = s.charAt(i);
        var code = c.charCodeAt(0);
        if (/\s/.test(c)) { i++; continue; }
        if (isCJK(code)) {
          var j = i;
          while (j < n && isCJK(s.charCodeAt(j))) j++;
          var k = i;
          while (k < j) {
            var e = Math.min(k + step, j);
            out.push({ s: k, e: e });
            k = e;
          }
          i = j;
          continue;
        }
        if (isWordChar(c)) {
          var w = i;
          while (w < n && isWordChar(s.charAt(w))) w++;
          out.push({ s: i, e: w });
          i = w;
          continue;
        }
        if (out.length > 0) {
          out[out.length - 1].e = i + 1;
        } else {
          out.push({ s: i, e: i + 1 });
        }
        i++;
      }
      return out;
    }

    // ===== V7.37：按「词」切块 =====
    // 单字块选中文要一个一个点，太碎；单词模式用 ICU 的词典分词
    // （android.icu.text.BreakIterator，API 24+ 自带，纯计算无绘制），
    // 中文按词、英文按单词、数字/型号整段不拆。
    // 返回 null 表示 ICU 不可用，调用方退回 splitPickSegments（按字）。
    // 注意：这里只做字符串运算，绝不碰 View / Paint，不会重演 V7.33 的
    // 「TextView 绘制把 system_server 带崩」。
    function splitPickWords(text) {
      var s = String(text || "");
      if (!s) return [];
      var spans = [];
      try {
        var it = android.icu.text.BreakIterator.getWordInstance(java.util.Locale.CHINA);
        it.setText(s);
        var p = it.first();
        var cur = it.next();
        var guard = 0;
        while (cur !== -1 && cur > p && guard < 8000) {   // -1 = DONE
          spans.push({ s: p, e: cur });
          p = cur;
          cur = it.next();
          guard++;
        }
      } catch (eBi) {
        return null;
      }
      if (!spans.length) return null;
      var out = [];
      for (var i = 0; i < spans.length; i++) {
        var a = spans[i].s;
        var b = spans[i].e;
        if (b <= a || b > s.length) continue;
        var piece = s.substring(a, b);
        if (!/\S/.test(piece)) continue;                       // 纯空白丢弃
        // ICU 会把标点单独切出来。挂到前一个词尾巴上（"你好，" 是一个块），
        // 避免出现一个只能点「，」的孤块。
        var isPunct = !/[0-9A-Za-z\u4e00-\u9fff\u3400-\u4dbf]/.test(piece);
        if (isPunct && out.length > 0) {
          out[out.length - 1].e = b;
          continue;
        }
        out.push({ s: a, e: b });
      }
      // V7.80：单个块最长 12 字。ICU 词典缺失的 ROM 会把整句当成一个 span，
      // 那种块点一下就把整句选走（比按字还难用）。超长的先按标点切，切完还
      // 长就等分 —— 正常分词每块 1~4 字，走不到这段，一个块都不会被动到。
      var MAXSEG = 12;
      var out2 = [];
      for (var q = 0; q < out.length; q++) {
        var a2 = out[q].s, b2 = out[q].e;
        while (b2 - a2 > MAXSEG) {
          var cut = a2 + MAXSEG;
          // 先往回找一个标点（最多退到窗口一半），再往后看两个字 ——
          // 目的是"切在标点后面"，别把「，」甩到下一块开头。
          for (var m2 = cut; m2 > a2 + (MAXSEG >> 1); m2--) {
            if (/[，。！？；：、,.!?;:]/.test(s.charAt(m2 - 1))) { cut = m2; break; }
          }
          if (cut === a2 + MAXSEG) {
            for (var n2 = cut + 1; n2 <= cut + 2 && n2 < b2; n2++) {
              if (/[，。！？；：、,.!?;:]/.test(s.charAt(n2 - 1))) { cut = n2; break; }
            }
          }
          out2.push({ s: a2, e: cut });
          a2 = cut;
        }
        out2.push({ s: a2, e: b2 });
      }
      return out2.length ? out2 : null;
    }

    // 选中块按原文顺序拼接；块间若有换行补 \n，有其他间隔补一个空格。
    function joinPickSegments(text, segs, selected) {
      var s = String(text || "");
      var out = "";
      var last = -1;
      for (var i = 0; i < segs.length; i++) {
        if (!selected || !selected[i]) continue;
        var seg = segs[i];
        if (last >= 0) {
          var gap = s.substring(last, seg.s);
          if (/[\r\n]/.test(gap)) out += "\n";
          else if (/\s/.test(gap)) out += " ";
          // 原文这里本来就没有空白（中文里点掉了中间几个字）→ 什么都不加。
          // 旧写法只要 gap.length>0 就补空格，"你好世界"点掉"好"会变成
          // "你 世界" —— 用户要的是删字，不是插空格。
        }
        out += s.substring(seg.s, seg.e);
        last = seg.e;
      }
      return trimText(out);
    }
    function makeStrokeBg(fillColor, strokeColor, strokeWidth, radius) { var g = new android.graphics.drawable.GradientDrawable(); g.setColor(jint(fillColor)); g.setStroke(dp(strokeWidth), jint(strokeColor)); g.setCornerRadius(dp(radius)); return g; }
    function paintArgb(p, a, r, g, b) {
      try { p.setARGB(a & 255, r & 255, g & 255, b & 255); } catch(e) {}
    }
    // 通道混合：c 与白色按 k 混合（k=0 纯白，k=1 纯色）
    function mixChannel(c, k) { return Math.round(255 - (255 - (c & 255)) * k); }
    // 由强调色生成淡色（用于渐变/纯色回退）
    function tintColor(r, g, b, k, a) {
      return jint(((a & 255) << 24) | ((mixChannel(r, k) & 255) << 16) | ((mixChannel(g, k) & 255) << 8) | (mixChannel(b, k) & 255));
    }
    // 渐变创建（失败返回 null，调用方回退纯色填充，保证任何机型可用）
    function makeLinearGradient(x0, y0, x1, y1, c0, c1) {
      try {
        var tm = android.graphics.Shader.TileMode.CLAMP;
        return new android.graphics.LinearGradient(x0, y0, x1, y1, c0, c1, tm);
      } catch(e) { return null; }
    }
    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
    function clampPointerX(appObj, x) {
      return clamp(x, -appObj.pickLocalX, appObj.screenW - appObj.pickLocalX);
    }
    function clampPointerY(appObj, y) {
      return clamp(y, -appObj.pickLocalY, appObj.screenH - appObj.pickLocalY - appObj.navigationBarHeight);
    }

    function trimText(v) {
      try { return String(v).replace(/^\s+|\s+$/g, ""); } catch(e) { return ""; }
    }
    function sdkInt() {
      try { return android.os.Build.VERSION.SDK_INT; } catch(e) { return 0; }
    }
    function charText(v) {
      try {
        if (v === null || v === undefined) return "";
        return trimText(String(v));
      } catch(e) {
        return "";
      }
    }
    function pushUniqueText(arr, v) {
      var s = charText(v);
      if (!s) return;
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] === s) return;
      }
      arr.push(s);
    }
    // ===== 文本控件专用过滤 =====
    // 只针对真正有屏幕文字的控件取字和画框；图标、纯布局容器仍然排除。
    // 注意：Button / MaterialButton / AppCompatButton 如果 getText() 有内容，现在允许取字。
    function classContains(cls, key) {
      try { return String(cls || "").indexOf(key) >= 0; } catch(e) { return false; }
    }
    function isExcludedPickClass(cls) {
      cls = String(cls || "");
      if (!cls) return true;
      // 图标 / 图片。很多图标只有 contentDescription，不能当作屏幕文字取字。
      if (classContains(cls, "ImageView")) return true;
      if (classContains(cls, "ImageButton")) return true;
      if (classContains(cls, "Icon")) return true;

      // 图标动作类控件：保留排除。普通 Button / MaterialButton 不再排除，后面必须通过 getText() 校验。
      if (classContains(cls, "FloatingActionButton")) return true;
      if (classContains(cls, "ActionMenu")) return true;

      // 表单状态控件：暂不作为普通取字对象，避免误选开关/单选状态。
      if (classContains(cls, "Switch")) return true;
      if (classContains(cls, "CheckBox")) return true;
      if (classContains(cls, "RadioButton")) return true;
      if (classContains(cls, "CompoundButton")) return true;
      if (classContains(cls, "SeekBar")) return true;
      if (classContains(cls, "ProgressBar")) return true;
      if (classContains(cls, "RatingBar")) return true;
      if (classContains(cls, "Spinner")) return true;

      // 容器/布局类：即使子节点有文字，也不再把父布局拿来画框。
      if (classContains(cls, "ViewGroup")) return true;
      if (classContains(cls, "LinearLayout")) return true;
      if (classContains(cls, "FrameLayout")) return true;
      if (classContains(cls, "RelativeLayout")) return true;
      if (classContains(cls, "ConstraintLayout")) return true;
      if (classContains(cls, "RecyclerView")) return true;
      if (classContains(cls, "ScrollView")) return true;
      if (classContains(cls, "ListView")) return true;
      if (classContains(cls, "GridView")) return true;
      if (classContains(cls, "Toolbar")) return true;
      return false;
    }
    function isTextPickClass(cls) {
      cls = String(cls || "");
      if (!cls || isExcludedPickClass(cls)) return false;
      // 允许文字控件和带 getText() 的按钮控件；是否真正可取字由 isValidTextPickNode 再检查文本内容。
      if (classContains(cls, "EditText")) return true;
      if (classContains(cls, "TextView")) return true;
      if (classContains(cls, "CheckedTextView")) return true;
      if (classContains(cls, "TextInputEditText")) return true;
      if (classContains(cls, "MaterialTextView")) return true;
      if (classContains(cls, "AppCompatTextView")) return true;
      if (classContains(cls, "Button")) return true;
      if (classContains(cls, "MaterialButton")) return true;
      if (classContains(cls, "AppCompatButton")) return true;

      // 兼容模式：部分 Compose / Flutter / WebView 子节点 className 可能只是 android.view.View，
      // 但仍然必须由 isValidTextPickNode 再检查 getText() 是否有真实文字。
      try {
        if (typeof app !== "undefined" && app && app.pickMode === 2 && cls === "android.view.View") return true;
      } catch(ePickMode) {}

      return false;
    }
    function nodeDirectScreenTextParts(n, cls) {
      var arr = [];
      if (!n) return arr;
      // 只读取直接显示在文字控件上的文本；不读取 contentDescription，避免图标/按钮标签混入。
      try { pushUniqueText(arr, n.getText()); } catch(e0) {}
      // EditText 的 hint 也可能是屏幕上可见文字。
      try {
        if (classContains(cls, "EditText") || classContains(cls, "TextInputEditText")) {
          pushUniqueText(arr, n.getHintText());
        }
      } catch(e1) {}
      return arr;
    }
    function nodeDirectScreenText(n, cls) {
      var arr = nodeDirectScreenTextParts(n, cls);
      if (arr.length > 0) return arr.join("\n");
      return "";
    }
    function isValidTextPickNode(n, cls, pickOk, info) {
      if (!pickOk) return false;
      if (!info) return false;
      // 排除只有符号/空白的伪文字，例如单独的图标字体字符。
      try {
        var plain = String(info).replace(/\s+/g, "");
        if (plain.length <= 0) return false;
        // 如果完全没有字母、数字、中文/日文/韩文等常见文字，只保守排除。
        if (!/[0-9A-Za-z\u2E80-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(plain)) return false;
      } catch(e2) {}
      return true;
    }
    function nodeClassName(n) {
      try {
        var c = n.getClassName();
        if (c) return String(c);
      } catch(e) {}
      return "";
    }
    function nodePackageName(n) {
      try {
        var p = n.getPackageName();
        if (p) return String(p);
      } catch(e) {}
      return "";
    }
    function nodeChildCount(n) {
      try { return n.getChildCount(); } catch(e) { return 0; }
    }
    function nodeVisible(n) {
      try { return n.isVisibleToUser(); } catch(e) { return true; }
    }
    function textClassRank(cls) {
      if (!cls) return 7;
      if (cls.indexOf("EditText") >= 0) return 0;
      if (cls.indexOf("TextView") >= 0) return 1;
      if (cls.indexOf("Button") >= 0) return 2;
      if (cls.indexOf("CheckedTextView") >= 0) return 2;
      if (cls.indexOf("Switch") >= 0) return 3;
      if (cls.indexOf("CheckBox") >= 0) return 3;
      if (cls.indexOf("RadioButton") >= 0) return 3;
      if (cls.indexOf("ImageView") >= 0) return 5;
      if (cls.indexOf("View") >= 0) return 4;
      return 6;
    }
    // ===== V7.0 优化：类名判定缓存 + 复用 Rect，减少每次查询的重复计算 =====
    var classKindCache = {};
    function classKindOf(cls) {
      var pm = 1;
      try { if (typeof app !== "undefined" && app && app.pickMode === 2) pm = 2; } catch(ePm) {}
      var key = pm + "|" + cls;
      var k = classKindCache[key];
      if (k === undefined) {
        k = (isTextPickClass(cls) ? 1 : 0) | (textClassRank(cls) << 1);
        classKindCache[key] = k;
      }
      return k;
    }
    var scratchBounds = new android.graphics.Rect();
    function getBoundsInto(n, out) {
      try { n.getBoundsInScreen(out); return out; } catch(e) { return null; }
    }
    function rectInside(x, y, r) { return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
    function rectInsidePad(x, y, r, padX, padY) {
      padX = Math.max(0, Number(padX || 0));
      padY = Math.max(0, Number(padY || 0));
      return x >= r.left - padX && x <= r.right + padX && y >= r.top - padY && y <= r.bottom + padY;
    }
    function rectCenterDistance(x, y, r) { var cx = (r.left + r.right) / 2; var cy = (r.top + r.bottom) / 2; return Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)); }
    function rectDistanceToPoint(x, y, r) {
      var dx = 0;
      var dy = 0;
      if (x < r.left) dx = r.left - x;
      else if (x > r.right) dx = x - r.right;
      if (y < r.top) dy = r.top - y;
      else if (y > r.bottom) dy = y - r.bottom;
      return Math.sqrt(dx * dx + dy * dy);
    }
    // V7.21：文字矩形命中分级（从 findBestNode.hitModeForTextRect 提取为
    // 顶层函数，零行为变化；a11y 通道与 OCR 通道共用同一套命中判定）。
    // 返回 0=指针在 bounds 内 / 1=pad 扩展区 / 2=上下轻量吸附 /
    //      3=左右边缘吸附 / -1=未命中。
    function hitModeForRect(r, x, y, textHitPadX, textHitPadY, textSnapSideX, textSnapVertY, textLinePadX) {
      textHitPadX = Math.max(0, Number(textHitPadX || 0));
      textHitPadY = Math.max(0, Number(textHitPadY || 0));
      textSnapSideX = Math.max(0, Number(textSnapSideX || 0));
      textSnapVertY = Math.max(0, Number(textSnapVertY || 0));
      textLinePadX = Math.max(0, Number(textLinePadX || 0));
      if (rectInside(x, y, r)) return 0;
      if (rectInsidePad(x, y, r, textHitPadX, textHitPadY)) return 1;

      var dx = 0;
      var dy = 0;
      if (x < r.left) dx = r.left - x;
      else if (x > r.right) dx = x - r.right;
      if (y < r.top) dy = r.top - y;
      else if (y > r.bottom) dy = y - r.bottom;

      // 文字通常是一条横向线：允许指针在文字正上/正下方一点点，解决小字号文本难命中。
      // 但横向必须基本对齐文本范围，避免指针在右侧较远处仍吸附标题。
      var lineAlignedX = x >= r.left - textLinePadX && x <= r.right + textLinePadX;
      if (lineAlignedX && dy <= textSnapVertY) return 2;

      // 允许贴近文字左右边缘少量吸附，但横向距离必须很小。
      var lineAlignedY = y >= r.top - textSnapVertY && y <= r.bottom + textSnapVertY;
      if (lineAlignedY && dx <= textSnapSideX) return 3;

      return -1;
    }

    function getPrefetchFlags() {
      var f = 0;
      try { f |= android.view.accessibility.AccessibilityNodeInfo.FLAG_PREFETCH_DESCENDANTS_DEPTH_FIRST; } catch(e0) {}
      try { f |= android.view.accessibility.AccessibilityNodeInfo.FLAG_PREFETCH_SIBLINGS; } catch(e1) {}
      return f;
    }
    function getWindowRoot(win) {
      if (!win) return null;
      var root = null;
      var flags = getPrefetchFlags();
      try {
        if (sdkInt() >= 33 && flags !== 0) root = win.getRoot(flags);
      } catch(e0) { root = null; }
      if (!root) {
        try { root = win.getRoot(); } catch(e1) { root = null; }
      }
      return root;
    }
    function getActiveRoot(ui) {
      var root = null;
      // V7.20：主路径改为无 flags 的标准调用。诊断实证（OnePlus PLC110 /
      // ColorOS / SDK36）：无 flags 调用全树 364 节点完整可达；带
      // FLAG_PREFETCH_* 的 root 在该 ROM 上遍历完整性未经验证，且
      // prefetch 是 API33+ 新行为——正确性优先，prefetch 降级为回退。
      try { root = ui.getRootInActiveWindow(); } catch(e1) { root = null; }
      if (!root) {
        var flags = getPrefetchFlags();
        try {
          if (sdkInt() >= 33 && flags !== 0) root = ui.getRootInActiveWindow(flags);
        } catch(e0) { root = null; }
      }
      return root;
    }
    function ensureUiAutomation(ui) {
      try { if (!ui.isConnected()) ui.connect(); } catch(e0) { try { ui.connect(); } catch(e00) {} }
      try {
        var info = ui.getServiceInfo();
        var flags = Number(info.flags);
        try { flags = flags | android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS; } catch(e1) {}
        try { flags = flags | android.accessibilityservice.AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS; } catch(e2) {}
        try { flags = flags | android.accessibilityservice.AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS; } catch(e3) {}
        info.flags = flags;
        ui.setServiceInfo(info);
      } catch(e4) {}
    }

    // ===== 优化：增加 stopSearch 标志，找到小控件立即返回 =====
    function findBestNode(rootNode, x, y, maxArea, textHitPadX, textHitPadY, textSnapSideX, textSnapVertY, textLinePadX) {
      var containing = [];
      // 平衡命中策略：
      // 1) 优先要求 + 中心落入文字控件原始 bounds；
      // 2) 其次允许很小的文字 bounds 扩展；
      // 3) 再允许“同一行/上下方很近”的轻量吸附；
      // 4) 不再使用无限制最近节点吸附，避免指针在较远位置误框文字。
      textHitPadX = Math.max(0, Number(textHitPadX || 0));
      textHitPadY = Math.max(0, Number(textHitPadY || 0));
      textSnapSideX = Math.max(0, Number(textSnapSideX || 0));
      textSnapVertY = Math.max(0, Number(textSnapVertY || 0));
      textLinePadX = Math.max(0, Number(textLinePadX || 0));

      // V7.20：删除 isSelfOverlayRect（与 APP V7.37 同源决策——该几何排除
      // 会误杀短文本）。

      // V7.21：命中判定提取至顶层 hitModeForRect（OCR 通道共用），此处仅包装
      function hitModeForTextRect(r) {
        return hitModeForRect(r, x, y, textHitPadX, textHitPadY, textSnapSideX, textSnapVertY, textLinePadX);
      }

      function makeItem(n, r, depth, hitMode, distanceToRect, cls, rank, childCount, pickOk) {
        var w = r.right - r.left;
        var h = r.bottom - r.top;
        var area = Math.max(1, w * h);
        // 文本控件专用：只取节点自身的屏幕文字，不聚合子节点、不用 id/contentDescription 兜底。
        var info = nodeDirectScreenText(n, cls);
        if (!info || !isValidTextPickNode(n, cls, pickOk, info)) return null;
        return {
          rect: r,
          area: area,
          distance: distanceToRect,
          centerDistance: rectCenterDistance(x, y, r),
          depth: depth,
          childCount: childCount,
          classRank: rank,
          className: cls,
          packageName: nodePackageName(n),
          info: info,
          fallbackInfo: "",
          contains: hitMode >= 0,
          hitMode: hitMode
        };
      }

      function compareInside(a, b) {
        // 越严格的命中优先：原始 bounds > 小扩展区 > 上下轻量吸附 > 左右边缘吸附。
        if (a.hitMode !== b.hitMode) return a.hitMode - b.hitMode;
        if (a.distance !== b.distance) return a.distance - b.distance;
        if (a.area !== b.area) return a.area - b.area;
        if (a.classRank !== b.classRank) return a.classRank - b.classRank;
        return a.centerDistance - b.centerDistance;
      }

      // ===== 优化：引入停止标志 =====
      var stopSearch = false;
      var smallAreaThreshold = dp(40) * dp(40);

      function dfs(n, depth) {
        if (!n || stopSearch) return;
        var r = null;
        try { r = getBoundsInto(n, scratchBounds); } catch(e0) { r = null; }
        // V7.20：bounds 无效不再跳过整棵子树。酷安首页实测：全树 364 节点中
        // 191 个零 bounds、横向 ViewPager 滑出的 tab bounds 为 right<left 的
        // 异常值；V7.19 在此处 return 会把指针所在分支的祖先链整条剪断，
        // 表现为"完全识别不到任何文字"（树里明明有 83 个带文字节点）。
        // 现在：bounds 无效仅取消该节点自身的候选资格，子树一律继续遍历。
        var boundsOk = !!r;
        var w = 0;
        var h = 0;
        if (boundsOk) {
          w = r.right - r.left;
          h = r.bottom - r.top;
          if (w <= 0 || h <= 0) boundsOk = false;
        }
        // V7.20：不可见节点同样不再跳过子树（父不可见/子可见的自定义视图
        // 存在），不可见仅取消候选资格；contains/nearParent 照常参与剪枝。
        var selfVisible = true;
        try { selfVisible = nodeVisible(n); } catch(eVis) { selfVisible = true; }

        var area = boundsOk ? w * h : 0;
        var contains = boundsOk && rectInside(x, y, r);
        // 无效 bounds 节点不成候选，该距离值不参与排序，给 0 即可。
        var distanceToRect = boundsOk ? rectDistanceToPoint(x, y, r) : 0;
        var childCount = nodeChildCount(n);

        var clsForPick = nodeClassName(n);
        var kind = classKindOf(clsForPick);
        var textPickClass = (kind & 1) === 1;
        // 候选要求：bounds 有效 + 自身可见 + 文字类 + 命中（hitMode>=0）。
        var hitMode = (boundsOk && selfVisible && textPickClass) ? hitModeForTextRect(r) : -1;
        var textContains = hitMode >= 0;

        // 大容器/根节点不能直接 return；只是不作为候选，仍继续遍历子节点。
        var canBeCandidate = (maxArea <= 0 || area <= maxArea || childCount === 0);
        if (canBeCandidate && textPickClass && textContains) {
          var item = makeItem(n, new android.graphics.Rect(scratchBounds), depth, hitMode, distanceToRect, clsForPick, (kind >> 1), childCount, textPickClass);
          if (item && item.info) {
            containing.push(item);
            // ===== 优化：如果控件面积很小（例如 ≤ dp(40)*dp(40)），认为已找到最优目标，立即停止搜索 =====
            if (area <= smallAreaThreshold) {
              stopSearch = true;
              return;
            }
          }
        }

        // 遍历策略：
        // - 父节点包含 + 时正常向下找；
        // - 父节点离 + 很近时也允许向下扫一层，解决文字控件边缘/小字号难进入的问题；
        // - bounds 无效节点没有几何信息可供剪枝，无条件展开子树（V7.20 防断链）；
        // - 可见子树仍不做全屏扫描，避免 RecyclerView 列表里远处文本被误吸附。
        var nearParent = boundsOk && distanceToRect <= Math.max(textSnapSideX, textSnapVertY, textHitPadX, textHitPadY) + dp(6);
        if ((contains || textContains || nearParent || depth <= 1 || !boundsOk) && !stopSearch) {
          for (var i = 0; i < childCount && !stopSearch; i++) {
            var child = null;
            try { child = n.getChild(i); } catch(e2) { child = null; }
            if (child) {
              try { dfs(child, depth + 1); }
              finally { try { child.recycle(); } catch(eRecycleDfsChild) {} }
            }
          }
        }
      }

      dfs(rootNode, 0);

      if (containing.length > 0) {
        containing.sort(compareInside);
        if (containing[0] && containing[0].info) return containing[0];
      }
      // 没有命中文字控件本体或文字附近小范围时，不画框、不取字。
      return null;
    }

    // ============================================================
    // 修改指针：鼠标箭头（放大版），尖端 = 取字点
    // 指针窗口定位在手指左上方，箭头整体可见不被手指遮挡
    // ============================================================
    function createPointerView(app) {
      var PointerView = JavaAdapter(android.view.View, {
        onDraw: function(canvas) {
          try {
            var p = app.paint;
            var tipX = app.pickLocalX;
            var tipY = app.pickLocalY;
            var textActive = !!(app.currentText && app.currentTextRect);
            var areaMode = !!app.areaModeActive;
            var active = areaMode || textActive;
            var dragging = !!app.dragging;
            var stateKey = areaMode ? 'area' : (textActive ? 'text' : (dragging ? 'drag' : 'idle'));

            // V7.8 状态色统一：取字态（空闲/拖动/命中文字）一律深蓝黑 (30,41,59)，
            // 仅框选态用蓝紫 (99,102,241)。删除原"命中文字→琥珀黄 (245,158,11)"第三套色——
            // 启动落点是否命中文字不再改变边框颜色（原缺陷：启动时偶尔黄边框）
            var accentR = areaMode ? 99 : 30;
            var accentG = areaMode ? 102 : 41;
            var accentB = areaMode ? 241 : 59;

            p.setAntiAlias(true);
            p.setStrokeCap(android.graphics.Paint.Cap.ROUND);
            p.setStrokeJoin(android.graphics.Paint.Join.ROUND);
            try { p.setShader(null); p.clearShadowLayer(); } catch(e0) {}

            // ============ 鼠标箭头（V7.12：用回 V7.11 经典造型，整体缩 7/8） ============
            // 几何：尖端 → 左缘直下（脊柱）→ 内凹 → 下翅尖（全图最低点）→ 翅内缘 →
            //       回提 → 尾右缘 → 顶缘斜线回尖端。即 V7.11 原款造型（16×19dp），
            //       整体缩 7/8 至 14×16.6dp（按用户要求"缩一点点"）。
            //       尖端仍在窗口内 (16,8)dp，取字点与全部偏移 / 钳制逻辑不变。
            var path = app.arrowPath;
            if (!path) {
              path = new android.graphics.Path();
              path.moveTo(tipX, tipY);                        // 尖端（取字点）
              path.lineTo(tipX, tipY + dp(14.4));             // 左缘（脊柱直下）
              path.lineTo(tipX + dp(4.0), tipY + dp(10.6));   // 内凹
              path.lineTo(tipX + dp(7.3), tipY + dp(16.6));   // 下翅尖（最低点）
              path.lineTo(tipX + dp(10.6), tipY + dp(14.8));  // 翅内缘
              path.lineTo(tipX + dp(8.1), tipY + dp(9.9));    // 回提
              path.lineTo(tipX + dp(14.0), tipY + dp(9.9));   // 尾右缘
              path.close();                                    // 顶缘斜线回尖端
              app.arrowPath = path;
            }

            // 箭头渐变（按状态缓存，避免每帧创建 Shader；创建失败 → null → 纯色回退）
            if (app.arrowShaderKey !== stateKey || !app.arrowShader) {
              app.arrowShaderKey = stateKey;
              app.arrowShader = makeLinearGradient(tipX, tipY, tipX, tipY + dp(20),
                jint(0xFFFFFFFF), tintColor(accentR, accentG, accentB, active ? 0.16 : 0.05, 255));
            }
            p.setStyle(android.graphics.Paint.Style.FILL);
            paintArgb(p, 255, 252, 253, 255); // 渐变不可用时的纯色回退
            try { p.setShader(app.arrowShader); } catch(eSh) {}
            try { p.setShadowLayer(dp(3.5), dp(1), dp(1.5), app.shadowJint || jint(0x40000000)); } catch(e1) {}
            canvas.drawPath(path, p);
            try { p.clearShadowLayer(); } catch(e2) {}
            try { p.setShader(null); } catch(eSh2) {}

            // 外描边（V7.8：取字态统一深蓝黑，框选态蓝紫强调；不再随命中文字变色）
            p.setStyle(android.graphics.Paint.Style.STROKE);
            p.setStrokeWidth(dp(1.6));
            paintArgb(p, 255, accentR, accentG, accentB);
            canvas.drawPath(path, p);

            // 尖端取字点提示（实际取字点仍是箭头尖端；圆点大小统一，仅亮度随状态微调）
            p.setStyle(android.graphics.Paint.Style.FILL);
            paintArgb(p, active ? 245 : 205, accentR, accentG, accentB);
            canvas.drawCircle(tipX, tipY, dp(2.2), p);

          } catch(drawError) {
            // V7.11.1：主画法异常时回退最简箭头（无渐变 / 无投影 / 无缓存路径），
            // 保证任何情况下箭头都画得出来——绝不让异常把整帧吃掉，
            // 表现为「窗口抓得到、功能全正常、唯独箭头不显示」
            try {
              var fp = app.paint;
              var ftx = app.pickLocalX, fty = app.pickLocalY;
              var fpath = new android.graphics.Path();
              fpath.moveTo(ftx, fty);
              fpath.lineTo(ftx, fty + dp(14.4));
              fpath.lineTo(ftx + dp(4.0), fty + dp(10.6));
              fpath.lineTo(ftx + dp(7.3), fty + dp(16.6));
              fpath.lineTo(ftx + dp(10.6), fty + dp(14.8));
              fpath.lineTo(ftx + dp(8.1), fty + dp(9.9));
              fpath.lineTo(ftx + dp(14.0), fty + dp(9.9));
              fpath.close();
              try { fp.setShader(null); fp.clearShadowLayer(); } catch(e3) {}
              fp.setAntiAlias(true);
              fp.setStrokeCap(android.graphics.Paint.Cap.ROUND);
              fp.setStrokeJoin(android.graphics.Paint.Join.ROUND);
              fp.setStyle(android.graphics.Paint.Style.FILL);
              paintArgb(fp, 255, 250, 251, 253);
              canvas.drawPath(fpath, fp);
              fp.setStyle(android.graphics.Paint.Style.STROKE);
              fp.setStrokeWidth(dp(1.6));
              paintArgb(fp, 255, 30, 41, 59);
              canvas.drawPath(fpath, fp);
              fp.setStyle(android.graphics.Paint.Style.FILL);
              paintArgb(fp, 255, 30, 41, 59);
              canvas.drawCircle(ftx, fty, dp(2.2), fp);
            } catch(drawError2) {}
          }
        }
      }, context);
      PointerView.setLayerType(android.view.View.LAYER_TYPE_SOFTWARE, null);
      return PointerView;
    }

    app = {
      wm: null,
      pointer: null,
      pointerLp: null,
      frame: null,
      frameLp: null,
      textPanel: null,
      paint: null,
      // 本次拖拽的屏幕偏移校准（DOWN 时用触摸坐标反推，正常为 0）；
      // MOVE 以手指反推窗口位置时需要扣除，保证与 DOWN 跳转基准一致
      dragCalX: 0,
      dragCalY: 0,
      // V7.33.7：本次按下时的距边值（加速量起算点）——
      // DOWN 时在 effectiveOffset 内记录，该时刻加速量恒为 0
      dragGapX0: 0,
      dragGapY0: 0,
      // 指针窗口尺寸（V7.3：60×84dp 大触摸窗，与原版一致的手感；
      // 窗口除箭头外全部透明——底部约 50dp 即「透明握点」，
      // 相当于把原先的圆形按钮变成透明：看不见但抓得到）
      pointerW: dp(60),
      pointerH: dp(84),
      // 取字点 = 箭头尖端在窗口内的位置（applySnap/clamp/hotspot 均以它为准）
      // 箭头绘制在窗口左上方，尖端即窗口内 (16,8)dp
      pickLocalX: dp(16),
      pickLocalY: dp(8),
      // 按下时指针跳转：箭头尖端落在手指左上方的该偏移处。
      // V7.9：37.3×50.3dp（V7.8 及以前为 32×44dp，各 +1/3 箭头尺寸 5.3/6.3dp，
      // 按"再挪开一点点"微调——既躲开手指又不让尖端远离指尖影响瞄准）。
      // 偏移使整支箭头（16×19dp）避开指尖：箭头占据手指左上
      // (21.3~37.3, 31.3~50.3)dp，右缘余量 21.3dp、上方余量 31.3dp
      // （原 16/25dp），手指与拇指根部不再遮挡箭头。
      arrowOffsetX: dp(37.3),
      arrowOffsetY: dp(50.3),
      screenOffsetX: 0,
      screenOffsetY: 0,
      // 命中范围（优化小控件命中，增大容差）
      textHitPadX: dp(4),
      textHitPadY: dp(6),
      textSnapSideX: dp(4),
      textSnapVertY: dp(4),
      textLinePadX: dp(1),
      frameExpand: dp(1),
      pickMode: 1,
      // ===== 边缘阈值（V7.5 起用于计算右/下缘平滑收缩区间宽度）=====
      snapThreshold: dp(20),
      navigationBarHeight: 0,       // 将在 build 中计算
      // ===== 延时参数（修改为 1.5 秒） =====
      areaHoldDelay: 1500,          // 悬停进入截图
      areaIdleDelay: 1500,          // 截图无操作自动退出
      // ===== 优化卡顿 =====
      minLookupMove: dp(4),
      moveLookupInterval: 100,   // V7.0：后台查询不阻塞主线程，适当提高拖动查询频率
      clearCacheInterval: 1800,
      // ===== V7.21：OCR 兜底通道配置 =====
      ocrCooldown: 700,        // 两次 OCR 最小间隔（截图+OCR 实测约 500ms，留余量）
      ocrCacheTtl: 30000,      // V7.23：OCR 结果缓存有效期 2s→30s。APP 侧缓存是
                               // 会话级（close 整体丢弃、DOWN/停移按年龄保鲜刷新），
                               // 脚本对齐该语义：30s 内「移开再移回」走缓存即时
                               // 命中（同步匹配零延迟）；界面变化由保鲜刷新兜底，
                               // 30s 只是最终硬过期防线
      ocrRefreshMinAge: 1500,  // V7.23：保鲜刷新最小缓存年龄（对齐 APP
                               // Geom.OCR_REFRESH_MIN_AGE）——DOWN 时缓存年龄
                               // 超过该值才在后台刷新，刷新完成按当前位置重查校正
      ocrMissTrigger: 2,       // 连续 a11y 未命中次数达到该值才触发 OCR
                               // （MOVE 查询约 100ms 一次，2 次 ≈ 200ms 稳定未命中）
      a11yMissMemoMs: 300,     // V7.26：a11y 未命中短记忆时长。云闪付类自绘正文
                               // 页面 a11y 全路径必然 miss，每次悬停仍全树 DFS +
                               // 全窗口遍历（单次数百 IPC）→ 黄框慢半拍、UP 同步
                               // 查询阻塞主线程 ~2s（取消反馈延迟）。记忆热时（见
                               // queryAt）非 force 查询跳过 a11y 全路径直走 OCR
                               // 缓存快路。300ms > 拖动查询间隔 ~100ms → 记忆在
                               // 持续拖动中始终有效；暂停 >300ms 后自然失效，回到
                               // 完整路径（此时一次全路径开销可接受）
      a11yMissMaxMs: 2000,     // V7.27：短记忆总寿命上限（秒级兜底）。V7.26 的
                               // 「OCR 未命中不延长」语义导致无字区拖动中每 300ms
                               // 周期性冷查询（全路径 1~2s），既堵 bgHandler 又让
                               // UP 落入冷路径——现改为未命中也顺延 a11yMissAt，
                               // 由总寿命兜底：超过 2s 强制回一次完整路径重新判定
                               // （换页/弹窗场景），期间 a11y 命中双字段清零
      ocrMinConfidence: 0.3,   // OCR 块置信度下限（滤除噪声块）
      memoReapplyMaxMove: dp(24),  // V7.29：后台校验 apply 新鲜度阈值。校验
                               // 线程要跑 1~2s，期间手指持续移动：apply 前
                               // 比较校验坐标与最近查询坐标 lastQueryX/Y，
                               // 超阈值则丢弃 apply 只 renew（黄框不跳旧
                               // 位置）；校验开跑时 likewise 超阈值则改验
                               // 证当前 hotspot（结果才有 apply 价值）
      memoRevalidateGapMs: 800, // V7.29：a11y 独有 apply 分支的快轮询间隔
                               // （总寿命续到 800ms 后到期，该区域保持 ~1s
                               // 校验密度）；冗余/未命中/异常分支正常 2s
      // ===== V7.24.3：短文本噪声滤除（头像/图标误检，见 parseOcrBlocks）=====
      ocrNoiseConfidence: 0.65,// 短文本噪声的置信度上限：≤2 字符且置信度低于
                               // 该值、框宽异常（见下）才判噪声滤除。真实短名
                               // 「画竣」conf 0.51 与噪声「C」conf 0.51 相同，
                               // 单靠置信度无法分辨，必须联合框宽判据
      ocrNoiseWidthRatio: 1.4, // 短文本噪声的框宽/期望字宽和 比值上限：框宽超过
                               // 同高度正常文字（CJK/全角按 1.0 字高、Latin/
                               // 半角按 0.55 字高估算）的该倍数 → 框住的是
                               // 头像图案而非文字笔画（实测噪声 1.56~3.83，
                               // 正常文字 ≤1.15）
      // ===== V7.24.4：换行标题合并（wrappedLineMerge，见 buildOcrBlocks）=====
      ocrWrapMinChars: 6,      // 换行合并的最小行字符数：两行都达到该长度才判
                               // 「包裹换行」。防御性下限——真实换行行长远超
                               // 此值；短行（人名/标签/图标名，如「药小高」
                               // 「姣姣来了」）不触发，防把上下排版的小块误并
      ocrWrapWidthRatio: 1.33, // 换行合并的行宽比上限：两行宽度接近（包裹排版
                               // 的特征——上行满行、下行收尾）才判换行。实测
                               // 小红书标题两行 526px/484px=1.09；长行+短尾行
                               // （比值 >2，如标题 526px vs 作者名 179px=2.94）
                               // 不触发
      ocrWrapHRatio: 1.20,     // 换行合并的行高比上限：PaddleOCR 检测框高有
                               // 噪声（实测同字号两行 52px/61px=1.17，超出
                               // sameScale 的 1.12 被拆开），放宽到 1.20 只补
                               // sameScale 的漏；仍远小于标题/正文字号差
                               // （16sp/14sp 框高比常 >1.3，不会糊并）
      // ===== V7.24.5：空结果负缓存（防 miss 路径背靠背重跑，见 recordOcrResult）=====
      ocrEmptyCacheTtl: 8000,  // 空结果/失败负缓存的基础 TTL：OCR 无结果也按
                               // 「当前屏幕无可识别文字」缓存，miss 路径在该
                               // 时间内不重跑。根因（真机反馈「云闪付首页
                               // 识别特别卡顿」）：旧逻辑空结果不写缓存 →
                               // 缓存检查永不成立 → OCR 一完成（2~4s）隔
                               // 2 次 miss（~160ms）冷却已过立即再跑，整场
                               // 会话背靠背满占 CPU。连续空结果按
                               // effectiveCacheTtl 退避（8s→16s→30s 封顶），
                               // DOWN 保鲜刷新不受此限（用户按下即恢复）
      // ===== V7.23：块级聚合阈值（原样对齐 APP Geom，见 buildOcrBlocks）=====
      ocrHGapSplit: dp(12),    // 行内水平拆组：相邻单元水平间隙 > 该值即切开
                               // （APP Geom.ocrHGapSplit，桌面相邻图标名各成框）
      ocrVGapMerge: dp(20),    // 组间垂直合并间隙的退化兜底：正常判据为
                               // 「间隙 < 1.0 × 两组行高中位数的较大者」
                               // （V7.33 一行字高，见 buildOcrBlocks medH）；
                               // 仅行高信息缺失（理论不可达）时退回该绝对值
      ocrRowHRatio: 1.12,      // 同字号判据：块内行高中位数比值上限
                               // （APP Geom.ocrRowHRatio，标题/正文不误并）
      ocrRowHDiff: dp(2),      // 同字号判据：块内行高中位数差上限
                               // （APP Geom.ocrRowHDiff，≥2sp 字号差即分开）
      ocrPrewarmDelay: 300,    // V7.23：预热延迟——等指针窗添加完成并可见后再
                               // 预热（对齐 APP「箭头可见后预热」时机；V7.25 起
                               // 预热无条件，不再有 a11y 探测环节）
      dragFrameInterval: 0,     // V7.6：8→0（postDelayed(0) 立即入队）：跟手延迟从
                                // ≤8ms 降到约 0，合并粒度变为"消息循环轮次"——
                                // 同一批输入内的多个 MOVE 仍只布局一次，开销不变
      inspectMoveInterval: 80,
      upInspectDelay: 80,          // V7.34：松手后多久做 a11y 查询（必须离开输入回调）
      screenW: 0,
      screenH: 0,
      hot: false,
      // ===== V7.21：OCR 兜底运行时状态 =====
      lastOcrTryAt: 0,         // 上次 OCR 尝试时间戳（冷却控制）
      ocrBlocks: null,         // 上次 OCR 解析出的文字块 [{left,top,right,bottom,text,confidence}]
      ocrBlocksAt: 0,          // OCR 结果时间戳（缓存有效期控制）
      ocrMissCount: 0,         // 连续 a11y 未命中计数
      ocrRunning: false,       // OCR 进行中（防重入）
      // ===== V7.24.5：空结果负缓存退避 + OCR 诊断计数（见 recordOcrResult）=====
      ocrEmptyStreak: 0,       // 连续空结果次数（负缓存 TTL 退避档位）
      // ===== V7.25：a11y 实效判定（见 a11yEffective）=====
      a11yHits: 0,             // 本次会话 a11y 通道命中次数（OCR 命中不计）
      // ===== V7.26：a11y 未命中短记忆（见 queryAt）=====
      a11yMissAt: 0,           // 最近一次 a11y 全路径未命中的时间戳（0=记忆冷）。
                                // V7.27 起 OCR 未命中也顺延（拖动中记忆恒热），
                                // 实际语义 = 最近一次「判定页面 a11y 无效」的时刻
      a11yMissBase: 0,         // V7.27：本次记忆最初置位时刻（总寿命基准）——
                                // 未命中也顺延 a11yMissAt；V7.28 起总寿命到期
                                // 不再内联全路径，由 scheduleMemoRevalidate
                                // 后台校验续期（查询路径永不阻塞）
      memoValidating: false,   // V7.28：短记忆后台校验在途标志（去重，一次至多一个）
      currentText: "",
      currentTextRect: null,
      currentTextKey: "",
      currentPickClassName: "",
      currentPickPackageName: "",
      currentPickHitMode: -1,
      // 实时命中 + 松手即取：最近有效命中缓存。
      lastValidPickText: "",
      lastValidPickRect: null,
      lastValidPickKey: "",
      lastValidPickClassName: "",
      lastValidPickPackageName: "",
      lastValidPickHitMode: -1,
      lastValidPickTime: 0,
      lastValidPickExpireMs: 300,

      // ===== 区域截图模式 =====
      areaModeActive: false,
      areaHoldToken: 0,
      dragSession: 0,
      // V7.22：悬停锚点移动重置门限（对齐 APP V7.23 的 dp(3f)）——
      // >3dp 的可感知移动即重置锚点与计时，只有真正静止才累计 1.5s
      // 进框选；3dp 容差只防触摸抖动，不吞慢移。
      areaHoldStableSlop: dp(3),
      // 1.5s 到期时的距离确认阈值（APP 同款 dp(14f)，防计时期间缓动误差）
      areaHoldBreakSlop: dp(14),
      areaHoldAnchorX: -99999,
      areaHoldAnchorY: -99999,
      areaStartX: -1,
      areaStartY: -1,
      areaEndX: -1,
      areaEndY: -1,
      areaFrame: null,
      areaFrameLp: null,
      // 框选态：第二根手指点击取消用的全屏捕获窗
      areaCancelCatcher: null,
      // V7.18：取字态全屏触摸监视窗（窗外多指退出检测）
      pickWatcher: null,
      pickWatcherLp: null,       // V7.33.5：监视窗参数（尺寸随 screenW/H 同步）
      areaCaptureRunnable: null,
      areaFrozenVisualRect: null,
      areaFrozenCaptureRect: null,
      areaCapturing: false,
      // V7.33.7：截图前隐藏框选框后，内缩只需 1dp
      // 防一帧残影（旧值 3dp 是为裁掉 2dp 描边，边缘会少一条）
      areaCaptureInset: dp(1),
      // V7.33.7：边缘加速——距边 edgeAccelDist 内，尖端每 1dp 手指位移
      // 多走 edgeAccelGain dp（等效增益 ≈1.9×）；gain=0 即回退旧行为。
      // V7.33.11：加速区 80→53dp（缩小 1/3），更靠边才开始加速。
      edgeAccelDist: dp(53),
      // V7.33.8：0.75→0.45，位移增益约 1.9×
      // （原本 2.2×），贴边时刻从距边 ~30dp 收到 ~22dp，手感更温和
      edgeAccelGain: 0.45,
      areaMinSize: dp(8),
      // V7.54：松手→截图的固定等待。这 120ms 的唯一作用是让
      // areaFrame.setVisibility(INVISIBLE) 的那一帧真正合成出去（否则
      // 2dp 描边会被截进图里）。实测 3 帧（48ms @60Hz）就够，
      // 原来等于白等 5 帧 —— 这段在「松手到看得见」里是最纯的一段延迟。
      areaCaptureDelay: 48,
      // ===== V7.77：框选绘制的缓存（都是「算一次、用一帧」的东西）=====
      // areaDrawnRect：上一次真正提交绘制的框（屏幕坐标）。MOVE 用它算
      //   「旧框 ∪ 新框」脏区，onDraw 直接读它 —— 不再每帧 getAreaRect()
      //   造一个 {left,top,right,bottom,width,height} 临时对象。
      // areaStrokeW / areaStrokePad：描边宽、脏区外扩量，build 时算一次
      //   （原来 onDraw 每帧调一次 dp(2)，即每帧一次浮点乘加取整）。
      areaDrawnRect: null,
      areaStrokeW: dp(2),
      areaStrokePad: dp(2) + 2,
      // captureMethod：上一次成功的截图途径下标（captureAreaToFile 里
      //   tries[0..3]）。下次先试它 —— 免得在 Android 14/15 上每张图都从
      //   一条注定失败的通路起步，白构造一串 Rhino 异常。
      captureMethod: -1,

      // ===== V7.34：取字选择面板 =====
      selectPanel: true,            // 取字后弹面板让用户选词（false=旧行为：整段直接复制）
      selectPanelMinChars: 1,       // 少于此字数不弹（1=总是弹）
      selectPanelMaxChars: 2000,    // 多于此字数不弹（超长文本直接复制更实际）
      selectPanelDelay: 260,        // 松手后多久才建面板：必须离开输入回调窗口期
      // V7.48：**没有**「无操作自动关闭」。旧版 60s 定时器会在用户还在读字、
      // 还没挑完的时候把面板收走，连带丢掉已选。面板的正常结束方式只有四种：
      // 点复制、点取消、点面板外、第二根手指。
      // selectPanelHoldMs 不是「无操作超时」，而是会话挂死时的收尾闸门
      // （面板一旦挂住，全屏监视窗会跟着留下，整机触摸就废了）。30 分钟
      // 意味着正常读字永远碰不到；写 0 = 连这道闸都不要，面板永不自动收。
      selectPanelHoldMs: 1800000,  // 面板停留硬上限（ms），0=不设上限
      selectChunk: 1,               // 单字模式下的块大小：1=单字，2=双字（词模式忽略）
      panelMode: "word",            // V7.37：word=按词切（默认）/ char=按字切；面板左下角可临时切
      panelTheme: "auto",           // auto=跟随系统深色模式；light/dark=强制
      probe: true,                  // 崩溃定位探针（Download/屏幕取字_probe.log）
      panelGuard: true,             // 上次面板异常未收尾时，本次不弹（自愈防连崩）
      panelForce: false,            // true=无视自愈守卫，强制弹面板

      // ===== V7.35：框选截图后的选字面板 =====
      // 截图落盘后先对这张 PNG 做一次 OCR：有文字就弹面板选词，用户确认后
      // 交付 area_capture + data.pickedText（导入侧 OCR 动作优先取它）；
      // 没文字、超时、用户点屏幕跳过、面板建不起来 → 原样交付截图。
      areaOcrPanel: true,           // false=旧行为：只出图，不识别不弹面板
      areaOcrMinChars: 1,           // 少于此字数不弹
      areaOcrMaxChars: 2000,        // 多于此字数不弹（整段太长，面板装不下）
      areaOcrTimeout: 8000,         // OCR 看门狗（ms）：到点不再等，直接交付截图
      // V7.54：OCR 完成→弹面板的间隔，120→0。这条回调本身就是在主线程
      // 空闲时才跑起来的（OCR 线程 post 回来的），再挂 120ms 只是把
      // 「已经算完的字」在手里多攥了两秒的十分之一。0 = 排到队尾，
      // 该让出的那一帧照样让出。
      areaOcrPanelDelay: 0,
      lastLookup: 0,
      // ===== V7.0 优化字段 =====
      uiAutomation: null,
      lastEnsureUi: 0,
      // ===== V7.13 新增字段 =====
      // onDraw 投影色预算缓存：build 时算一次，拖动热路径零 Integer 装箱
      // （paintArgb 走 setARGB(int,int,int,int) 本就无装箱；原来每帧
      //  new Integer 的只有投影色这一处）
      shadowJint: null,
      // 屏幕尺寸惰性刷新节流时间戳（旋转 / 分屏适配）
      lastMetricsCheck: 0,
      // 截图阶段诊断：screenshot / save（captureAreaToFile 内更新，
      // 失败时随 data.stage 返回，便于定位是哪一步挂的）
      captureStage: "",
      bgThread: null,
      bgHandler: null,
      bgEnabled: true,
      lookupTask: null,
      querySeq: 0,
      queryInFlight: 0,         // V7.27：在途后台查询数（一次性线程模型下的并发上限）
      queryMaxInflight: 2,      // V7.27：并发冷查询上限——超出则丢弃新查询（位置
                                // 会持续更新，丢失旧查询无损失；防多个全路径慢
                                // 查询并发互踩 IPC）
      arrowPath: null,
      // 美化：箭头渐变按状态缓存（idle/drag/text/area），避免每帧创建 Shader
      arrowShader: null,
      arrowShaderKey: '',
      lastQueryX: -99999,
      lastQueryY: -99999,
      lastClearCache: 0,
      lastRectKey: "",
      lastFrameState: -1,
      pickTriggered: false,
      handler: null,
      // ===== V7.34：选择面板运行时状态 =====
      selectPanelDone: false,       // 本次会话面板已开过（防重入）
      selectPanelFailed: false,     // 建面板失败过（回退直接复制）
      selectPanelInfo: null,        // { root, host, bmp, layout, segs, text, selected }
      pendingPick: null,            // 面板确认后要交付的 { text, hp, rect }
      // ===== V7.35：框选截图的选字状态 =====
      areaResult: null,             // 本次截图的交付信息 { path, visualRect, captureRect }
      areaOcrRunning: false,        // OCR 在跑（用户点屏幕可跳过）
      areaOcrTimer: null,           // OCR 看门狗
      // V7.54：分段计时基准（0 = 本次没有截图链路，日志不输出差值）
      areaT0: 0,                    // 松手时刻
      areaOcrDoneAt: 0,             // OCR 出结果的时刻
      // V7.55：面板里显示的截图缩略图（截图线程里缩好，最多 480px 高）。
      // 只占 0.5MB —— 绝不留原图（8.9MB 会把 system_server 推向 OOM）。
      areaThumb: null,
      panelKind: "text",            // 面板用途："text"=取字 / "area"=截图后选字
      upHandled: false,             // UP 已受理（post 只发一次）
      dragging: false,
      pendingPointerX: 0,
      pendingPointerY: 0,
      dragUpdatePosted: false,
      lastInspectMove: 0,
      inspectPosted: false,
      closed: false,

      // ===== 空闲超时 + 容错 =====
      areaHasBeenDragged: false,
      areaIdleRunnable: null,
      lastStableMoveX: 0,
      lastStableMoveY: 0,
      moveStableThreshold: dp(4)
    };

    // ===== V7.34：探针开关 + 会话标记 + 崩溃自愈 =====
    // 注意位置：必须放在 app 对象**之后**。放到函数最开头的话 app 还是 null，
    // 守卫条件 `app && app.panelGuard` 恒假，等于整段自愈从不生效。
    try { PROBE_ON = (app && app.probe !== false); } catch(ePo) {}
    var CUR_VER = "7.80";   // 自愈守卫按版本隔离，必须与头注一致
    if (app && app.selectPanel && app.panelGuard !== false && app.panelForce !== true) {
      var crashedBefore = false;
      try { crashedBefore = probeLastPanelCrashed(); } catch(eG) { crashedBefore = false; }
      if (crashedBefore) {
        app.selectPanel = false;          // 本次直接复制，绝不再弹
        try { probeLog("GUARD_OFF last panel session did not finish"); } catch(eG2) {}
        var gotCrash = false;
        try { gotCrash = grabSystemCrashLog(); } catch(eGC) {}
        var copied = false;
        try {
          var tail = probeTail(1800);
          if (tail) {
            var cm = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(android.content.ClipData.newPlainText("屏幕取字崩溃日志", tail));
            copied = true;
          }
        } catch(eGClip) {}
        // V7.43：这里原本有一条长 Toast 说明"上次面板异常、本次直接复制"。
        // 用户要求全静音，删掉提示；日志仍在剪贴板与 crash.txt 里，
        // 需要时自己取。probe 记一行便于对照。
        try { probeLog("PANEL_GUARD_NOTICE copied=" + (copied ? 1 : 0) + " crash=" + (gotCrash ? 1 : 0)); } catch(eG3) {}
      }
    }
    try { probeRotateIfBig(262144); } catch(eRot) {}
    // V7.53：会话行带上本进程 pid。自愈守卫靠它区分两种"没有 CLOSE_DONE"：
    // 真崩溃（进程没了）vs 面板还开着（进程活着）。取不到就写 0。
    var MY_PID = 0;
    try { MY_PID = Number(android.os.Process.myPid()); } catch(ePidSelf) { MY_PID = 0; }
    try { probeLog("===== SESSION v" + CUR_VER + " pid=" + MY_PID + " panel=" + (app && app.selectPanel ? 1 : 0) + " ====="); } catch(ePs) {}

    // ===== 边缘处理（V7.5：仅钳制，不再硬吸附瞬移）=====
    // V6.4~V7.4 的边缘吸附是"尖端进入 60px 吸附区即瞬移到边缘"，位置有
    // 60px 级跳变（左/上缘）或与收缩叠加出更明显的顿挫（右/下缘）。
    // V7.5 起四边统一为平滑行为，由 effectiveOffset + clampPointer 共同完成：
    //   - 左/上缘：偏移方向本就指向屏幕内侧，clampPointer 把窗口压住，
    //     尖端平滑停在边缘（手指继续移动时尖端贴住不动，即"吸附"）；
    //   - 右/下缘：effectiveOffset 平滑收缩偏移，尖端随手指平滑到达边缘。
    // 全程位置连续、无瞬移；snapThreshold 现仅用于计算收缩区间宽度。
    app.applySnap = function(x, y) {
      // 应用边界限制（四边平滑贴边，见上）
      x = clampPointerX(this, x);
      y = clampPointerY(this, y);
      return { x: x, y: y };
    };

    // ===== V7.5：边缘感知偏移（smoothstep 平滑收缩）=====
    // 箭头尖端在手指左上方 arrowOffset 处；接近右/下缘时偏移平滑收缩到 0，
    // 手指贴到边缘时尖端也贴到边缘。收缩区间宽度 = 2*(偏移+吸附阈值)，
    // 并用 smoothstep 缓动：尖端速度从 1× 渐入渐出（峰值约 1.5×）、
    // 位置 C1 连续——消除 V7.4 线性收缩的速度突变（1×→2×）与末端
    // 硬吸附瞬移（60px）叠加造成的"一跳一跳"感。
    // 左/上缘无需收缩（偏移本身指向屏幕内侧，由 clamp 平滑压住）。
    app.edgeZoneX = function() { return (this.arrowOffsetX + this.snapThreshold) * 2; };
    app.edgeZoneY = function() { return (this.arrowOffsetY + this.snapThreshold) * 2; };
    app.effectiveOffset = function(rx, ry) {
      var offX = this.arrowOffsetX;
      var offY = this.arrowOffsetY;
      var gapX = this.screenW - rx;
      var gapY = (this.screenH - this.navigationBarHeight) - ry;
      // V7.33.7：DOWN 时记录本次拖拽的起点距边值。
      // 加速量从这里起算，保证按下瞬间（gap == 起点）加量为 0——箭头
      // 仍精确落在手指左上方，不会「一跳就到边」。
      if (!this.dragging) {
        this.dragGapX0 = gapX;
        this.dragGapY0 = gapY;
      }
      if (gapX < this.edgeZoneX()) {
        var t = gapX > 0 ? gapX / this.edgeZoneX() : 0;
        offX = Math.round(offX * (t * t * (3 - 2 * t)));
      }
      if (gapY < this.edgeZoneY()) {
        var t2 = gapY > 0 ? gapY / this.edgeZoneY() : 0;
        offY = Math.round(offY * (t2 * t2 * (3 - 2 * t2)));
      }
      // V7.33.7：边缘加速——把所有 offset 再减去
      // 「进入加速区以来的手指位移 × gain」。offset 可为负：尖端越过
      // 手指继续向边缘走，于是在手指离边还有一段距离时就贴住边。
      // 只在拖动中生效（DOWN 放置保持 1:1）；取字与框选共用本函数。
      var accDist = Number(this.edgeAccelDist) || 0;
      var accGain = Number(this.edgeAccelGain) || 0;
      if (this.dragging && accDist > 0 && accGain > 0) {
        if (gapX < accDist) {
          var startX = Math.min(Math.max(this.dragGapX0 || 0, 0), accDist);
          var boostX = Math.max(0, startX - Math.max(gapX, 0)) * accGain;
          if (boostX > 1) offX -= Math.round(boostX);
        }
        if (gapY < accDist) {
          var startY = Math.min(Math.max(this.dragGapY0 || 0, 0), accDist);
          var boostY = Math.max(0, startY - Math.max(gapY, 0)) * accGain;
          if (boostY > 1) offY -= Math.round(boostY);
        }
      }
      return { x: offX, y: offY };
    };

    // ===== 所有函数 =====
    app.getPointerLocationOnScreen = function() {
      if (!this.pointer || !this.pointerLp) return null;
      try {
        if (!this._locArray) this._locArray = java.lang.reflect.Array.newInstance(java.lang.Integer.TYPE, 2);
        var arr = this._locArray;
        this.pointer.getLocationOnScreen(arr);
        var sx = Number(arr[0]);
        var sy = Number(arr[1]);
        if (!isNaN(sx) && !isNaN(sy)) {
          // 合理性校验：本窗口为 FLAG_LAYOUT_IN_SCREEN 全屏悬浮窗，lp 坐标即
          // 屏幕坐标，偏移应接近 0。若窗口尚未布局，个别机型会返回 (0,0)，
          // 直接采信会把指针/取字点算到错误方向——此时保留上一次有效校准。
          var offX = sx - Number(this.pointerLp.x || 0);
          var offY = sy - Number(this.pointerLp.y || 0);
          if (offX >= -200 && offX <= 200 && offY >= -400 && offY <= 400) {
            this.screenOffsetX = offX;
            this.screenOffsetY = offY;
            return { x: sx, y: sy };
          }
        }
      } catch(e) {}
      return null;
    };

    app.hotspot = function() {
      var loc = this.getPointerLocationOnScreen();
      var baseX, baseY;
      if (this.dragging && this.dragUpdatePosted) {
        baseX = this.pendingPointerX + this.screenOffsetX;
        baseY = this.pendingPointerY + this.screenOffsetY;
      } else if (loc) {
        baseX = loc.x;
        baseY = loc.y;
      } else {
        baseX = this.pointerLp.x + this.screenOffsetX;
        baseY = this.pointerLp.y + this.screenOffsetY;
      }
      return { x: baseX + this.pickLocalX, y: baseY + this.pickLocalY };
    };

    app.hotspotFromPointerXY = function(px, py) {
      return {
        x: Math.round(px + this.pickLocalX + this.screenOffsetX),
        y: Math.round(py + this.pickLocalY + this.screenOffsetY)
      };
    };

    // ===== 查询（纯数据，可在后台线程执行）=====
    // 顺序：短记忆 OCR 快路（~1ms）→ a11y 活动窗口 DFS → 全窗口遍历
    // → OCR 缓存兜底。短记忆三态（alive/expired/cold）见下方判定块。
    // 约束：查询路径永不阻塞——慢路径全在 daemon 线程；force（UP/停止）
    // 只做轻量化，不清缓存（所见即所取）。
    app.queryAt = function(x, y, force, noMemo) {
      var ui = this.uiAutomation;
      if (!ui) {
        try { ui = shortx.getUiAutomation(); } catch(eUi) { ui = null; }
        this.uiAutomation = ui;
      }
      if (!ui) return null;
      var now = nowMs();
      try {
        // 服务标志正常情况下构建时只设置一次，这里每 5 秒低频重放做保险
        if (now - this.lastEnsureUi > 5000) {
          this.lastEnsureUi = now;
          try { ensureUiAutomation(ui); } catch(eEnsure) {}
        }
        // ===== V7.28：a11y 未命中短记忆三态判定 =====
        // alive：滑窗(a11yMissMemoMs)内且总寿命(a11yMissMaxMs)内 →
        //   OCR 快路（~1ms）；
        // expired：滑窗内但总寿命到期 → **仍服务 OCR 快路**，另触发
        //   后台校验（scheduleMemoRevalidate）——V7.27 在此内联全
        //   路径（1~2s），持续拖动中每 ~2s 堵一次查询路径，真机复测
        //   「黄框还是慢半拍」的直接来源；
        // cold：滑窗外/从未置位 → 完整路径；bgEnabled=false（后台查询
        //   不可用的降级模式）下 expired 也走完整路径（无线程可派发）。
        // noMemo：后台校验专用——绕过快路直走完整路径。
        // V7.30：门控追加 a11y 实效条件——本会话
        //   a11y 命中过（a11yHits>0，a11y 通道证明可用）且 OCR 缓存
        //   未就绪时，快路让位 a11y 全路径（a11y 优先）：否则启动期
        //   一次 miss 就把应用锁进 OCR 快路，预热未完成期间黄框
        //   消失（酷安实测）。a11y 从未命中的应用（云闪付类）第一
        //   子句为真，快路全程生效（短记忆机制的设计场景）。
        // V7.33.2：门控再收紧为 !a11yProven——V7.30
        //   的「命中过 + OCR 就绪仍走快路」分支会让 OCR 结果覆盖
        //   a11y 拾取（桌面真机：图标与两段文字被 OCR 合并成一行），
        //   与「a11y 优先于 OCR」的用户预期相反；快路自此只服务
        //   a11y 通道证明不可用的应用（云闪付类短记忆设计场景不变），
        //   a11y 命中过的应用全程走 a11y 全路径（queryAt 尾段 OCR
        //   兜底保留：a11y 未命中区域仍有 OCR 兜底，只是不再走快路）。
        var cacheFresh = !!this.ocrBlocks && this.ocrBlocks.length > 0 &&
          (now - this.ocrBlocksAt) <= this.effectiveCacheTtl();
        var a11yProven = (this.a11yHits || 0) > 0;
        var memoRecent = !!this.a11yMissAt &&
          (now - this.a11yMissAt) < this.a11yMissMemoMs;
        var memoAlive = memoRecent &&
          (now - this.a11yMissBase) < this.a11yMissMaxMs;
        if (memoRecent && !force && !noMemo && (memoAlive || this.bgEnabled) &&
            !a11yProven) {
          var ocrFast = this.matchOcrBlocks(x, y, this.textHitPadX, this.textHitPadY, this.textSnapSideX, this.textSnapVertY, this.textLinePadX);
          this.a11yMissAt = now; // V7.27：命中/未命中都顺延——拖动中（含空白
                                 // 区）记忆恒热；总寿命到期由后台校验续期
          if (!memoAlive) {
            // V7.28：总寿命到期——查询照常返回 OCR 快路结果，完整路径
            // 校验改到 daemon 线程跑（查询路径永不阻塞）
            try { this.scheduleMemoRevalidate(x, y); } catch(eSc) {}
          }
          if (ocrFast) return ocrFast;
          return null; // OCR 也未命中：普通 miss（记忆已顺延）
        }
        // V7.27：forceLean 不要求记忆热（memo 三态下 alive/expired 均
        // 可轻量化）——记忆过期（空白停留后松手）但缓存新鲜时同样走
        // 轻量化，UP 不再落入 clearCache + 全路径的 ~2s 阻塞（真机
        // 「取消延迟」直接根因）
        // V7.33.2：追加 !a11yProven——a11y 证明可用
        // 的应用（桌面/微信等）松手时必须走 a11y 全路径，不让 OCR
        // 快路抢先覆盖 a11y 拾取（桌面 UP 提交被 OCR 合并行顶替的
        // 第二条路径）；a11y 从未命中的应用（云闪付类）轻量化零
        // 回归（V7.27 取消延迟修复不回退）。
        var forceLean = force && cacheFresh && !a11yProven;
        // forceLean 时不清缓存：与拖动期间出框所用 a11y 树同源（所见即所取），
        // 且 clearCache 的全量重拉正是 UP 同步查询阻塞 ~2s 的主因
        if (!forceLean && !this.dragging && (force || now - this.lastClearCache > this.clearCacheInterval)) {
          try { ui.clearCache(); this.lastClearCache = now; } catch(e1) {}
        }
        // forceLean：OCR 快路优先——缓存已覆盖该位置则 ~1ms 返回，
        // 不必再付活动窗口 DFS（UP 提交即时化）
        if (forceLean) {
          var ocrHitFirst = this.matchOcrBlocks(x, y, this.textHitPadX, this.textHitPadY, this.textSnapSideX, this.textSnapVertY, this.textLinePadX);
          if (ocrHitFirst) {
            return ocrHitFirst;
          }
          // OCR 未命中（图标按钮 contentDescription / 文字块间空隙）：
          // 仍走一次活动窗口 DFS 保取字正确性（下方快路径），不清缓存、
          // 不遍历全窗口
        }
        var result = null;
        var accessErr = null;
        var maxArea = Math.round(this.screenW * this.screenH * 0.45);
        // 快路径：仅查活动窗口（绝大多数场景一次命中，不再遍历所有窗口）
        try {
          var activeRoot = getActiveRoot(ui);
          if (activeRoot) {
            result = findBestNode(activeRoot, x, y, maxArea, this.textHitPadX, this.textHitPadY, this.textSnapSideX, this.textSnapVertY, this.textLinePadX);
            try { activeRoot.recycle(); } catch(e4) {}
          }
        } catch(e5) { accessErr = e5; }
        if (result && result.info) {
          this.a11yMissAt = 0; this.a11yMissBase = 0; // V7.27：a11y 命中双字段清零
          return result;
        }
        // 慢路径：遍历所有窗口（保留 V6.4 预取策略，跳过输入法窗口）。
        // forceLean（UP 轻量化）时跳过——活动窗口 + OCR 已覆盖指针会话
        // 场景，全窗口遍历是 UP 阻塞的第二大开销
        if (!forceLean) {
        try {
          var windows = ui.getWindows();
          if (windows) {
            var imeType = -1;
            try { imeType = android.view.accessibility.AccessibilityWindowInfo.TYPE_INPUT_METHOD; } catch(eIme) {}
            for (var i = 0; i < windows.size(); i++) {
              var win = windows.get(i);
              if (imeType >= 0) {
                try { if (win.getType() === imeType) continue; } catch(eT) {}
              }
              var rootFromWindow = getWindowRoot(win);
              if (rootFromWindow) {
                result = findBestNode(rootFromWindow, x, y, maxArea, this.textHitPadX, this.textHitPadY, this.textSnapSideX, this.textSnapVertY, this.textLinePadX);
                try { rootFromWindow.recycle(); } catch(e4) {}
                if (result && result.info) break;
              }
            }
          }
        } catch(e5) { if (!accessErr) accessErr = e5; }
        if (result && result.info) {
          this.a11yMissAt = 0; this.a11yMissBase = 0; // V7.27：a11y 命中双字段清零
          return result;
        }
        }
        // 根节点访问全部失败（如后台线程不允许调用 UiAutomation）时返回错误，
        // 与"未命中文本"区分开：调用方可据此回退主线程重查
        if (!result && accessErr) {
          return { error: String(accessErr) };
        }
        // V7.26：a11y 全路径未命中 → 短记忆置位（记忆热时悬停查询跳过 a11y）。
        // V7.27：同时置 a11yMissBase（总寿命基准）；若已有记忆（理论不可达
        // ——memo 快路已在上方处理 alive/expired），刷新 base 保持总寿命连续
        // V7.28：后台校验（noMemo）未命中也走这里——总寿命到期后由校验
        // 未命中重新起算，快路查询继续服务（查询路径永不阻塞）
        this.a11yMissAt = now;
        if (!this.a11yMissBase || (now - this.a11yMissBase) >= this.a11yMissMaxMs) {
          this.a11yMissBase = now; // 首次置位或总寿命已耗尽 → 重新起算
        }
        // V7.21：a11y 全路径未命中 → OCR 缓存块匹配（同步即时，不截图）。
        // 首次 OCR 由 applyInspectResult 未命中分支经 noteOcrMiss 调度，
        // 成功后缓存 ocrBlocks；此处使缓存期内的指针微调零延迟命中。
        var ocrHit = this.matchOcrBlocks(x, y, this.textHitPadX, this.textHitPadY, this.textSnapSideX, this.textSnapVertY, this.textLinePadX);
        if (ocrHit) return ocrHit;
        return result;
      } catch(e) {
        return { error: String(e) };
      }
    };

    // 短记忆总寿命到期的后台校验（queryAt expired 分支调用）。
    // 为什么不内联：完整路径 1~2s，内联会每 2s 堵一次查询路径。
    // 三条保护：坐标新鲜化（手指已移走则改验当前 hotspot）、apply 守卫
    // （坐标偏差超阈值只 renew 不 apply）、a11y 独有命中不清记忆。
    // 去重靠 memoValidating；closed 直接返回。
    app.scheduleMemoRevalidate = function(x, y) {
      if (this.closed || this.memoValidating) return;
      if (!this.bgEnabled) return; // 降级模式：queryAt 已内联走完整路径
      var self = this;
      this.memoValidating = true;
      var run = function() {
        try {
          if (self.closed) return;
          // V7.29：校验坐标新鲜化——校验要跑 1~2s，开跑时手指可能已
          // 明显移走：超 memoReapplyMaxMove 则改验当前 hotspot（旧坐标
          // 结果没有 apply 价值）
          var qx = x, qy = y;
          try {
            var hp0 = self.hotspot();
            if (hp0 && (Math.abs(hp0.x - x) > self.memoReapplyMaxMove ||
                        Math.abs(hp0.y - y) > self.memoReapplyMaxMove)) {
              qx = hp0.x; qy = hp0.y;
            }
          } catch(eHp0) {}
          var res = null;
          // noMemo=true：绕过短记忆快路，直走完整路径
          try { res = self.queryAt(qx, qy, false, true); } catch(eV) { res = { error: String(eV) }; }
          var h = self.handler;
          if (!h) return;
          h.post(new java.lang.Runnable({ run: function() {
            try {
              if (self.closed) return;
              var nr = nowMs();
              if (res && res.info) {
                // 与 OCR 冗余判定：同位置 OCR 也能命中 → 延续记忆
                var ocrDup = null;
                try {
                  ocrDup = self.matchOcrBlocks(qx, qy, self.textHitPadX, self.textHitPadY, self.textSnapSideX, self.textSnapVertY, self.textLinePadX);
                } catch(eOd) { ocrDup = null; }
                if (ocrDup) {
                  // 冗余：延续记忆（renew）
                  self.a11yMissAt = nr;
                  self.a11yMissBase = nr;
                } else {
                  // V7.29：a11y 独有内容——apply 前新鲜度守卫：apply 时
                  // 刻手指可能又移走，与最近查询坐标 lastQueryX/Y 偏差仍
                  // 超阈值 → 丢弃 apply 只 renew（黄框不跳旧位置）
                  var fresh = true;
                  try {
                    if (Math.abs(qx - (self.lastQueryX || 0)) > self.memoReapplyMaxMove ||
                        Math.abs(qy - (self.lastQueryY || 0)) > self.memoReapplyMaxMove) fresh = false;
                  } catch(eFr) { fresh = true; }
                  if (fresh) {
                    // V7.29：不再清记忆——查询路径永不回冷；a11y 独有内容
                    // 的发现完全交给本校验流水线（UP/停止有 force 同步
                    // 全路径兜底，松手正确性不降级）
                    self.applyInspectResult(res);
                    // 快轮询：总寿命续到 memoRevalidateGapMs 后到期
                    // （base + maxMs = now + gap），该区域保持 ~1s 校验密度
                    self.a11yMissAt = nr;
                    self.a11yMissBase = nr - self.a11yMissMaxMs + self.memoRevalidateGapMs;
                  } else {
                    self.a11yMissAt = nr;
                    self.a11yMissBase = nr;
                  }
                }
              } else if (res && res.error) {
                // 校验异常（如后台线程无 a11y 权限）：延续记忆，下周期重试
                self.a11yMissAt = nr;
                self.a11yMissBase = nr;
              }
              // 未命中：queryAt 的 miss 分支已重算 a11yMissBase，无需处理
            } finally {
              self.memoValidating = false;
            }
          }}));
        } catch(eTh) {
          self.memoValidating = false;
        }
      };
      try {
        var t = new java.lang.Thread(new java.lang.Runnable({ run: run }), "ShortXPointerMemoRevalidate");
        try { t.setDaemon(true); } catch(eTd) {}
        t.start();
      } catch(eThread) {
        // 线程创建失败（极端）：放弃本次校验，记忆延续，下个到期重试
        this.memoValidating = false;
      }
    };

    // V7.13：屏幕尺寸惰性刷新（旋转 / 分屏适配）。
    // 背景：screenW/H 与导航栏高度原是 build 时快照，会话中途旋转屏幕或进出
    // 分屏后，clampPointer / effectiveOffset / applySnap 仍按旧尺寸计算，
    // 尖端落点与边缘贴边会算错。本函数以 2 秒节流重读真实屏幕尺寸，
    // 由 DOWN / MOVE 路径调用；字段一变，钳制与收缩逻辑自动按新值生效。
    app.refreshScreenMetrics = function(force) {
      try {
        var now = nowMs();
        if (!force && now - this.lastMetricsCheck < 2000) return;
        this.lastMetricsCheck = now;
        var wmThis = this.wm;
        if (!wmThis) return;
        var w = 0, h = 0, nav = this.navigationBarHeight;
        // 真实尺寸：DisplayMetrics 优先（含系统装饰区），失败退回 getRealSize
        try {
          var dm = context.getResources().getDisplayMetrics();
          w = dm.widthPixels;
          h = dm.heightPixels;
        } catch(eDm) {}
        if (w <= 0 || h <= 0) {
          try {
            var disp = wmThis.getDefaultDisplay();
            var pt = new android.graphics.Point();
            disp.getRealSize(pt);
            w = pt.x;
            h = pt.y;
          } catch(eDisp) {}
        }
        if (w <= 0 || h <= 0) return; // 读不到就保留旧值，绝不清成 0
        // 导航栏高度：与 build 同策略（资源优先，Display 差值兜底）
        try {
          var resourceId = context.getResources().getIdentifier("navigation_bar_height", "dimen", "android");
          if (resourceId > 0) nav = context.getResources().getDimensionPixelSize(resourceId);
        } catch(eNav1) {}
        if (!nav) {
          try {
            var disp2 = wmThis.getDefaultDisplay();
            var realSize = new android.graphics.Point();
            var size = new android.graphics.Point();
            disp2.getRealSize(realSize);
            disp2.getSize(size);
            nav = realSize.y - size.y;
          } catch(eNav2) {}
        }
        // V7.33.5：尺寸变化时同步全屏监视窗——旋转/
        // 分屏/指标回退档修正后，窗口仍停在 build 时的宽高，露出的条带
        // 触摸会漏给下层应用（取字态误触应用），多指退出也收不到。
        var prevW = this.screenW;
        var prevH = this.screenH;
        this.screenW = w;
        this.screenH = h;
        this.navigationBarHeight = nav;
        if ((w !== prevW || h !== prevH) && this.pickWatcher &&
            this.pickWatcherLp && this.wm) {
          try {
            this.pickWatcherLp.width = w;
            this.pickWatcherLp.height = h;
            this.wm.updateViewLayout(this.pickWatcher, this.pickWatcherLp);
          } catch(eWatcherResize) {}
        }
      } catch(eRefresh) {}
    };

    // 异步查询：后台线程执行 queryAt，结果回主线程应用
    // V7.27：改一次性 daemon 线程（与 OCR 线程同款模型）。旧实现 post 到
    // bgHandler（ShortXPointerLookup 单线程 looper）——一次全路径慢查询
    // （云闪付 1~2s）占住 looper 期间，后续悬停查询全部排队，querySeq
    // 只丢弃过期结果、不取消排队中的执行 → 最新结果迟迟到不了主线程，
    // 黄框持续滞后（真机「慢半拍」第二根因）。独立线程互不排队；另加
    // seq 预检（跑之前发现已过期直接返回）与在途上限（防多个冷查询
    // 并发互踩 UiAutomation IPC）。
    app.lookupAtAsync = function(x, y, onDone) {
      var self = this;
      var seq = ++this.querySeq;
      // 在途查询已达上限：丢弃本次（位置持续更新，更新的查询马上会来）
      if ((this.queryInFlight || 0) >= this.queryMaxInflight) return;
      // counted：在途计数是否已计入（发起即计——若等任务开跑才计，线程
      // 挂起/调度延迟期间的上限检查会失效，并发冷查询仍可互踩 IPC）
      var counted = false;
      var run = function() {
        try {
          // seq 预检：已有更新查询时不必再跑（省 CPU，结果也会被丢）
          if (self.closed || seq < self.querySeq) return;
          var res = null;
          var err = null;
          try { res = self.queryAt(x, y, false); } catch(e) { err = e; }
          var h = self.handler;
          if (!h) return;
          h.post(new java.lang.Runnable({ run: function() {
            if (self.closed) return;
            if (seq < self.querySeq) return; // 已有更新的查询，丢弃过期结果
            if (err || (res && res.error)) {
              // 后台查询异常：永久回退为主线程同步查询
              self.bgEnabled = false;
              try { ensureUiAutomation(self.uiAutomation); } catch(eu) {}
              try { res = self.queryAt(x, y, false); } catch(e2) { res = null; }
            }
            try { onDone(res); } catch(e3) {}
          }}));
        } finally {
          if (counted) { self.queryInFlight -= 1; counted = false; }
        }
      };
      this.lookupTask = null; // 旧 bgHandler 任务模型停用（保留字段兼容 close 清理）
      try {
        var t = new java.lang.Thread(new java.lang.Runnable({ run: run }), "ShortXPointerLookupOnce");
        try { t.setDaemon(true); } catch(eTd) {}
        counted = true;
        this.queryInFlight = (this.queryInFlight || 0) + 1;
        t.start();
      } catch(eThread) {
        if (counted) { this.queryInFlight -= 1; counted = false; }
        // 线程创建失败（极端）：回退主线程同步查询
        try {
          this.bgEnabled = false;
          var res2 = null;
          try { res2 = this.queryAt(x, y, false); } catch(e4) { res2 = null; }
          try { onDone(res2); } catch(e5) {}
        } catch(eFallback) {}
      }
    };

    // 应用查询结果到 UI（必须在主线程调用）
    app.applyInspectResult = function(result) {
      if (this.closed || this.areaModeActive) return;
      var key = this.textKeyOf(result);
      if (result && result.rect && result.info) {
        this.currentText = String(result.info);
        this.currentTextRect = result.rect;
        this.currentTextKey = key;
        this.currentPickClassName = String(result.className || "");
        this.currentPickPackageName = String(result.packageName || "");
        this.currentPickHitMode = result.hitMode === undefined || result.hitMode === null ? -1 : Number(result.hitMode);
        this.lastValidPickText = this.currentText;
        this.lastValidPickRect = this.currentTextRect;
        this.lastValidPickKey = this.currentTextKey;
        this.lastValidPickClassName = this.currentPickClassName;
        this.lastValidPickPackageName = this.currentPickPackageName;
        this.lastValidPickHitMode = this.currentPickHitMode;
        this.lastValidPickTime = nowMs();
        this.ocrMissCount = 0; // V7.21：a11y/OCR 任一通道命中即清零未命中计数
        // V7.25：a11y 实效记账。a11y 命中（className 非 "OCR"）即证明
        // 本会话 a11y 通道可服务→保鲜不再浪费 OCR（见 a11yEffective
        // 头注：云闪付类页面 a11y 从不命中，OCR 缓存是唯一通道需持续
        // 保鲜）。
        // V7.26：命中不再取消预热就绪提示——「识别已就绪」曾因用户预热
        // 在途时悬到任一有文字控件（云闪付底部 tab 等）就被抑制，真机
        // 反馈偶发丢失；现预热完成无条件弹（见 runOcrFallback 完成回调）。
        if (this.currentPickClassName !== "OCR") {
          this.a11yHits = (this.a11yHits || 0) + 1;
        }
        this.hot = true;
        this.showFrame(result.rect);
        this.updateHotState(true);
      } else {
        this.currentText = "";
        this.currentTextRect = null;
        this.currentTextKey = "";
        this.currentPickClassName = "";
        this.currentPickPackageName = "";
        this.currentPickHitMode = -1;
        this.hot = false;
        this.hideFrame();
        this.updateHotState(true);
        // V7.21：a11y 未命中 → OCR 兜底调度（连续 miss 达阈值 + 冷却才触发）
        this.noteOcrMiss();
      }
    };

    // ============================================================
    // V7.21：OCR 兜底通道
    // 背景：APP 取字三通道（a11y 主 + desc 兜底 + OCR 兜底），脚本此前只有
    // a11y 单通道。微信小程序面板 a11y 损坏、图片内文字、Canvas 渲染文字
    // 等场景 a11y 树零命中，V7.21-diag-3 实证脚本内 OcrDetect(JSON) 可用
    // 后新增本通道：
    //   a11y 快慢路径均未命中 → 连续 miss 达阈值 → 独立线程全屏截图 +
    //   OcrDetect → 解析 blocks → 指针位置按 hitMode 分级匹配 → 命中走
    //   applyInspectResult 统一出框（className 标记 "OCR"）。
    // 关键设计：
    //   - 独立 java.lang.Thread 执行截图+OCR，不占 bgHandler——拖动时的
    //     a11y 后台查询不被阻塞（主通道响应优先）；
    //   - cooldown 700ms + ocrRunning 防重入，避免高频重复截图；
    //   - 命中判定与 a11y 通道共用 hitModeForRect（同款 pad/吸附参数），
    //     排序 hitMode → 距离 → 面积 → 中心距，与 compareInside 一致。
    // V7.23：缓存策略对齐 APP 三件套（解决「黄框出现慢 / 移开再移回失效」）：
    //   - 预热（startOcrPrewarm）：箭头可见后 300ms 直接后台 OCR 预热
    //     （V7.25 起无条件——原 a11y 探测门控的根因与改动见其头注），
    //     与用户瞄准时间重叠，完成弹「识别已就绪」；
    //   - 保鲜刷新（maybeRefreshOcrInBackground）：DOWN 时缓存年龄 >
    //     ocrRefreshMinAge(1.5s) 且 a11y 本会话从未命中（V7.25 a11y
    //     Effective 实效门控，取代探测）→ 后台刷新（串行防叠加），本次
    //     查询照常走缓存快路出结果，刷新完成按当前位置重查自动校正；
    //   - 缓存生命周期：TTL 延长至 30s（ocrCacheTtl），close 整体丢弃
    //     （会话间隙不复用）。30s 内「移开再移回」缓存即时命中（同步
    //     零延迟）；过期才重新走 miss → OCR 全链路。
    // V7.23：块级聚合（buildOcrBlocks，移植 APP V7.30~V7.32）——OCR 结果
    // 不再是原始行级 blocks，整段一框、标题/正文按字号分开，详见其头注。
    // ============================================================
    // V7.24.3：估算文本的正常检测框宽（短文本噪声滤除的分辨项）。
    // PaddleOCR 检测框紧贴文字笔画：CJK/全角字符字宽≈字高（方块字），
    // Latin/数字/半角字符字宽≈0.55 字高。头像图案被误检成 1~2 字符时，
    // 框住的是整块图案，框宽数倍于该估算值——以此与真实的短文本
    // （如「画竣」框宽 142px vs 估算 136px）区分。
    function expectedTextWidth(text, h) {
      var w = 0;
      for (var ci = 0; ci < text.length; ci++) {
        var cc = text.charCodeAt(ci);
        // 0x2E80~0xFEFF：CJK 部首/符号/假名/谚文、统一表意文字、兼容表意、
        // 全角符号等（字宽≈字高）；其余（Latin/数字/半角标点）≈0.55 字高
        w += (cc >= 0x2e80 && cc <= 0xfeff) ? h : h * 0.55;
      }
      return w;
    }
    // V7.23：解析 OcrDetect JSON → element 级最小单元（滤噪后）→ 块级聚合。
    // 聚合算法原样移植 APP OcrManager.buildBlocks（V7.30~V7.32），见
    // buildOcrBlocks；短注释：垂直聚类成行 → 行内水平拆组 → 组间垂直合并
    // （sameScale 同字号判据）→ 不动点合并 → \n 拼接。效果：整段一框、
    // 复制带换行；标题大字与正文小字、相邻图标名不误并。
    app.parseOcrBlocks = function(jsonText) {
      var units = [];
      try {
        var obj = JSON.parse(String(jsonText || ""));
        var arr = (obj && obj.blocks) ? obj.blocks : [];
        for (var i = 0; i < arr.length; i++) {
          var b = arr[i];
          if (!b) continue;
          var t = String(b.text || "").trim();
          if (!t) continue;
          var conf = Number(b.confidence || 0);
          if (conf < this.ocrMinConfidence) continue;
          var bd = b.bounds || {};
          var l = Number(bd.left || 0), tp = Number(bd.top || 0), rr = Number(bd.right || 0), bb = Number(bd.bottom || 0);
          if (!(rr > l && bb > tp)) continue;
          // V7.24.3：头像/图标噪声单元滤除。微信消息列表等场景，列表项
          // 左侧头像区的图案（字母 logo、图标）会被 PaddleOCR 误检成
          // 1~2 个字符的文本块：与消息预览垂直重叠 >30% 判同行、水平
          // 间隙 19~30px <dp(12) 拆不开，被并进消息选框污染复制内容
          // （真机诊断实测「E\nRaelynn:好的」等 4 例，46 单元中 4 个
          // 是头像噪声）。噪声共性：文本极短（≤2 字符）、置信度低
          // （<ocrNoiseConfidence）、检测框异常宽——框住的是整块头像
          // 图案而非文字笔画，框宽数倍于同高度正常文本。
          // 不能单靠置信度：真实短名「画竣」conf 0.51 与噪声「C」
          // conf 0.51 完全相同（真机数据）；「框宽 >1.4 倍期望字宽和」
          // 是唯一稳健分辨项——期望字宽按字符类型估算（CJK/全角 ≈1.0
          // 字高，Latin/半角 ≈0.55 字高），实测噪声比值 1.56~3.83、
          // 正常文字 ≤1.15。高置信度或框宽正常的短文本一律保留。
          if (t.length <= 2 && conf < this.ocrNoiseConfidence &&
              (rr - l) > this.ocrNoiseWidthRatio * expectedTextWidth(t, bb - tp)) continue;
          units.push({ left: l, top: tp, right: rr, bottom: bb, text: t, confidence: conf });
        }
      } catch(eParse) {}
      if (units.length === 0) return [];
      return this.buildOcrBlocks(units);
    };

    // V7.23：块级聚合（APP OcrManager.buildBlocks 原样移植，V7.30~V7.32）。
    // 输入：element 级最小单元 [{left,top,right,bottom,text,confidence}]
    //      （ShortX OcrDetect JSON 的 blocks 经 parseOcrBlocks 滤噪后）。
    // 算法四步（与 APP 逐行对应）：
    //  1)（单元收集已在 parseOcrBlocks 完成；脚本无指针浮层文字，不需要
    //     APP 的 tipRect 单元级剔除——截图链路本就不含悬浮窗）
    //  2) 垂直聚类成视觉行：按 top 排序扫一遍，垂直重叠占较短跨度
    //      ≥30%、或行中心距小于半个行高 → 同一视觉行（V7.24 起重叠
    //      需达 30% 阈值，原因见下行内注释）；
    //  3) 行内水平拆组：按 left 排序，相邻单元水平间隙 > ocrHGapSplit(12dp)
    //     切开（桌面相邻图标名各成框）；
    //  4) 组按阅读序排序后垂直合并成块：水平投影重叠 且 垂直间隙
    //     < 1.0 × 两组行高中位数的较大者（V7.33「一行字高」相对判据；
    //     原绝对 ocrVGapMerge(20dp) 不随字号/密度/字体缩放自适应）
    //     且（sameScale（块内行高中位数比 ≤1.12 且
    //     差 ≤2dp——标题行高大、正文行高小，纯几何分不开，必须靠行高差）
    //     或 wrappedLineMerge（V7.24.4：sameScale 漏判时的 OR 通道，
    //     修同字号两行框高噪声 52/61=1.17 被拆开，四道约束见其注释））
    //     且不过 colonSplitVeto（V7.24.3：上行无冒号短行 + 下行含冒号
    //     → 否决，修微信长群名缩字号后 sameScale 失效的误并）；
    //     顺序贪心可能漏掉间接相邻，多轮合并到不动点（块数很小，开销可忽略）。
    // 块内单元按阅读序重排（V7.24.4 orderBlockUnits：子行按 top、行内按
    // left——并入顺序会因同行 left 序与组间 top 序乱序，见其注释）后
    // 以 \n 拼接（复制到剪贴板保留段落结构）。
    app.buildOcrBlocks = function(units) {
      if (!units || units.length === 0) return [];
      var hGap = this.ocrHGapSplit;
      var vGap = this.ocrVGapMerge;  // V7.33：仅 medH 退化兜底引用
      var rowHRatio = this.ocrRowHRatio;
      var rowHDiff = this.ocrRowHDiff;
      // V7.24.4：换行标题合并通道阈值（见 wrappedLineMerge）
      var wrapMinChars = this.ocrWrapMinChars;
      var wrapWidthRatio = this.ocrWrapWidthRatio;
      var wrapHRatio = this.ocrWrapHRatio;
      // V7.24.3：竖并否决——「无冒号短行」紧贴「含冒号行」时不合并。
      // 根因（微信消息列表真机诊断，46 单元全量分析）：微信对放不下的
      // 长群名自动缩字号，缩到与消息预览同大时 sameScale 判据完全失效
      // （实测「【家长群-四年级7班】」框高 52px vs 消息 52px，比值
      // 1.00），名字与消息误并成一框（9 对中唯一漏网）。微信消息预览
      // 的结构特征是「发送者：内容」必带冒号（群聊），而联系人名基本
      // 不含冒号——以此作否决信号。约束（防误伤普通排版）：
      //   - 仅在上行无冒号且 ≤14 字符（联系人名特征）时否决；正文长行
      //     （>14 字符）不触发；
      //   - 仅在同字号判据放行时才否决——字号不同时 sameScale 旧规则
      //     已分开，否决只补 sameScale 的漏；
      //   - 普通正文段落无冒号不触发；聊天记录上下行都带冒号不触发；
      //   - 触发时后果仅是把两行拆成两块（用户可多选），远轻于名字与
      //     消息糊在同一框里。
      // V7.24.4：参数为块内单元数组（V7.24.3 起为文本数组，重构为单元
      // 数组以支撑 orderBlockUnits 的阅读序重排）。
      function colonSplitVeto(usAbove, usBelow) {
        var above = unitsText(usAbove, "");
        var below = unitsText(usBelow, "");
        if (above.length > 14) return false;
        if (/[:：]/.test(above)) return false;
        return /[:：]/.test(below);
      }
      // V7.24.4：块内单元文本拼接。sep 为 "" 时用于 colonSplitVeto 的
      // 冒号/长度判定（整块文本拼接），为 "\n" 时用于输出（按行拼接）。
      function unitsText(us, sep) {
        var s = "";
        for (var i = 0; i < us.length; i++) {
          if (i > 0) s += sep;
          s += us[i].text;
        }
        return s;
      }
      // V7.24.4：块内单元阅读序重排。根因（小红书发现页真机诊断，34 单元
      // 全量分析）——聚合块的文本原按「并入顺序」拼接，两个来源会乱序：
      //   a) 同一行聚类内按 left 排序，但单元实际上下堆叠：实测个人页
      //      「Florence」框高 108px 探到「memories」35px 上方，left 351
      //      > 327 反而排后，产出「memories\nFlorence」（读反了）；
      //   b) 组间按 (minTop, minLeft) 合并序：top 差 3px 的右组排前，
      //      实测「491」top 1539 比「药小高」1542 小 3px，被并到前面，
      //      产出「…牛肉丸\n491\n药小高」（作者名排到点赞数后面）。
      // 重排规则：单元按视觉中心纵坐标单链聚类成子行——与子行内任一
      // 单元中心距 < 0.9×较小框高 → 同一子行（同行单元中心距个位数
      // ~30px，换行单元 ≥53px，阈值取两者之间的安全分界）；子行间按
      // top、行内按 left（子行已按 cy 排序天然有序，行内重排 left）。
      // 不动块矩形，只改文本顺序；关注/2、消息/18 等同行单元保持左序，
      // 标题两行、正文行保持顶序，不回归。
      function orderBlockUnits(us) {
        if (!us || us.length <= 1) return us || [];
        var arr = us.slice();
        arr.sort(function(a, b) {
          return (a.top + a.bottom) / 2 - (b.top + b.bottom) / 2;
        });
        var subs = [];
        var cur = [arr[0]];
        for (var i = 1; i < arr.length; i++) {
          var u = arr[i];
          var cy = (u.top + u.bottom) / 2;
          var same = false;
          for (var k = 0; k < cur.length; k++) {
            var ck = cur[k];
            var ckCy = (ck.top + ck.bottom) / 2;
            var mh = Math.min(ck.bottom - ck.top, u.bottom - u.top);
            if (Math.abs(cy - ckCy) < mh * 0.9) { same = true; break; }
          }
          if (same) cur.push(u);
          else { subs.push(cur); cur = [u]; }
        }
        if (cur.length) subs.push(cur);
        var out = [];
        for (var s = 0; s < subs.length; s++) {
          if (subs[s].length > 1) {
            subs[s].sort(function(a, b) { return a.left - b.left; });
          }
          for (var m = 0; m < subs[s].length; m++) out.push(subs[s][m]);
        }
        return out;
      }
      // V7.33：垂直合并间隙的「一行字高」判据——阈值
      // 取两组行高中位数的较大者：dominant 行定义「一行」，小单元（标点/
      // 短词）不缩小阈值；行高缺失（理论不可达）退化回 ocrVGapMerge 绝对值。
      function medH(hs) {
        if (!hs || hs.length === 0) return vGap;
        var s = hs.slice().sort(function(a, b) { return a - b; });
        return s[Math.floor(s.length / 2)];
      }
      // 同字号判据（APP sameScale 原样）：两组行高取中位数（抗单行异常），
      // 比值与差都在阈值内才算同字号。任一组无高度信息时保守判同（不拦合并）。
      function sameScale(hs1, hs2) {
        if (hs1.length === 0 || hs2.length === 0) return true;
        var s1 = hs1.slice().sort(function(a, b) { return a - b; });
        var s2 = hs2.slice().sort(function(a, b) { return a - b; });
        var h1 = s1[Math.floor(s1.length / 2)];
        var h2 = s2[Math.floor(s2.length / 2)];
        var lo = Math.min(h1, h2);
        var hi = Math.max(h1, h2);
        return hi <= Math.floor(lo * rowHRatio) && hi - lo <= rowHDiff;
      }
      // V7.24.4：换行标题合并通道——sameScale 漏判时的 OR 通道。根因
      // （小红书发现页真机诊断）：标题换行显示时 PaddleOCR 对同字号
      // 两行的检测框高有噪声（实测「计划国庆变美？这几项」52px vs
      // 「项目，提前一周别碰」61px，比值 1.17 > sameScale 1.12），
      // 被误判不同字号拆成两块（复制只能拿到半句）。不能放松
      // sameScale：微信名字/内容比值 1.14、文档 16sp 标题/14sp 正文
      // 约 1.25，放宽会糊并标题正文（V7.23 Case9 回归破坏）。
      // 四道约束（与调用方的水平重叠 + 垂直间隙判据合起来用）：
      //   - 两行均 ≥wrapMinChars(6) 字符：防御性下限，短行（人名/
      //     标签/图标名）不触发，防把上下排版的小块误并；
      //   - 行宽比 ≤wrapWidthRatio(1.33)：包裹排版的特征——上行满行、
      //     下行收尾，两行宽度必然接近（实测标题 526/484=1.09）；
      //     长行+短尾行（>2）不触发；
      //   - 行高比 ≤wrapHRatio(1.20)：只容检测框高噪声（1.17），不容
      //     字号差（标题/正文 >1.3）；
      //   - 仍受 colonSplitVeto 约束（调用方统一把关，微信名字/消息
      //     不被新通道绕过）。
      // 安全性预演：微信 9 对名字/消息无一触发（宽比 1.16~2.41、高比
      // 1.00~1.55，均被至少一道约束拦下）；文档标题/正文（高比 >1.3
      // 或标题 <6 字符）不触发。
      function wrappedLineMerge(ra, ua, rb, ub) {
        // 防御：配置缺失时 fail-closed（不放行合并）——与 sameScale 缺配置时
        // NaN 比较为 false 的行为一致，避免恒真把任意两块都并上
        if (!wrapMinChars || !wrapWidthRatio || !wrapHRatio) return false;
        var sa = unitsText(ua, ""), sb = unitsText(ub, "");
        if (sa.length < wrapMinChars || sb.length < wrapMinChars) return false;
        var wa = ra.right - ra.left, wb = rb.right - rb.left;
        var wlo = Math.min(wa, wb), whi = Math.max(wa, wb);
        if (whi > wlo * wrapWidthRatio) return false;
        var ha = ra.bottom - ra.top, hb = rb.bottom - rb.top;
        var hlo = Math.min(ha, hb), hhi = Math.max(ha, hb);
        if (hhi > hlo * wrapHRatio) return false;
        return true;
      }
      // 2) 垂直聚类成视觉行
      var pool = units.slice();
      pool.sort(function(a, b) { return a.top - b.top; });
      var rows = [];
      var cur = null;
      var curTop = 0;
      var curBottom = 0;
      for (var i = 0; i < pool.length; i++) {
        var u = pool[i];
        if (!cur) {
          cur = [u];
          curTop = u.top;
          curBottom = u.bottom;
          continue;
        }
        var rowH = curBottom - curTop;
        var uH = u.bottom - u.top;
        // V7.24：重叠需占较短跨度的 30% 以上才算同一视觉行。
        // 根因（真机复现「标题跟正文一起框住」）：脚本侧 OcrDetect 是
        // PaddleOCR 风格检测器（diag-3 原始输出的 clsIdx/clsLabel/
        // clsConfidence 字段实证），检测框比 APP 用的 ML Kit element
        // 框松——标题底部常探进正文第一行顶部，旧规则「任何重叠即同行」
        // 把标题+正文第一行并进同一行聚类，后续 sameScale 行高判据被
        // 绕过（同一组内不再拆分），于是标题正文误并成一框。
        // 同一视觉行内单元的重叠通常 ≥80%（基线对齐、框高相近），而
        // 标题/正文的意外重叠多在 5~25%——30% 取两者之间的安全分界，
        // 与 APP 观感对齐（APP 偶发误并、脚本显著减少）。
        // 行中心距判据（<半个行高仍算同行）保持不变，兜底「无重叠但
        // 基线极近」的行。注意：sameScale 不能放进行聚类步骤——同行
        // 内 Latin（矮框）与 CJK（高框）高度比常 >1.12，放进来会错误
        // 拆行；它只用于第 4 步组间垂直合并。
        var overlap = Math.min(curBottom, u.bottom) - Math.max(curTop, u.top);
        var sameRow = overlap >= Math.min(uH, rowH) * 0.3 ||
          Math.abs((u.top + u.bottom) / 2 - (curTop + curBottom) / 2) < rowH * 0.5;
        if (sameRow) {
          cur.push(u);
          if (u.bottom > curBottom) curBottom = u.bottom;
        } else {
          rows.push(cur);
          cur = [u];
          curTop = u.top;
          curBottom = u.bottom;
        }
      }
      if (cur) rows.push(cur);
      // 3) 行内水平拆组
      var groups = [];
      for (var ri = 0; ri < rows.length; ri++) {
        var row = rows[ri].slice();
        row.sort(function(a, b) { return a.left - b.left; });
        var g = null;
        var gRight = 0;
        for (var j = 0; j < row.length; j++) {
          var uu = row[j];
          if (!g) {
            g = [uu];
            gRight = uu.right;
            continue;
          }
          if (uu.left - gRight > hGap) {
            groups.push(g);
            g = [uu];
            gRight = uu.right;
          } else {
            g.push(uu);
            if (uu.right > gRight) gRight = uu.right;
          }
        }
        if (g) groups.push(g);
      }
      // 4) 组按阅读序（minTop, minLeft）排序后垂直合并成块
      groups.sort(function(a, b) {
        var ta = Infinity, la = Infinity, tb = Infinity, lb = Infinity;
        for (var k = 0; k < a.length; k++) {
          if (a[k].top < ta) ta = a[k].top;
          if (a[k].left < la) la = a[k].left;
        }
        for (var k2 = 0; k2 < b.length; k2++) {
          if (b[k2].top < tb) tb = b[k2].top;
          if (b[k2].left < lb) lb = b[k2].left;
        }
        if (ta !== tb) return ta - tb;
        return la - lb;
      });
      var blocks = [];   // {left,top,right,bottom} 并集矩形
      var bunits = [];   // 块内单元（对象数组，按并入顺序；V7.24.4 起存单元
                         // 而非纯文本，支撑 orderBlockUnits 阅读序重排）
      var heights = [];  // 块内单元高度（行高，字号代理）
      var confs = [];    // 块内最低置信度（聚合块取最弱成员，保守）
      for (var gi = 0; gi < groups.length; gi++) {
        var grp = groups[gi];
        // 组内按 left 排序（阅读序），直接作为块内单元数组
        var us = grp.slice().sort(function(a, b) { return a.left - b.left; });
        var r = { left: us[0].left, top: us[0].top, right: us[0].right, bottom: us[0].bottom };
        var hs = [];
        var minConf = 1;
        for (var si = 0; si < us.length; si++) {
          var su = us[si];
          if (su.left < r.left) r.left = su.left;
          if (su.top < r.top) r.top = su.top;
          if (su.right > r.right) r.right = su.right;
          if (su.bottom > r.bottom) r.bottom = su.bottom;
          hs.push(su.bottom - su.top);
          if (su.confidence < minConf) minConf = su.confidence;
        }
        var placed = false;
        for (var bi = 0; bi < blocks.length; bi++) {
          var b = blocks[bi];
          if (Math.min(b.right, r.right) - Math.max(b.left, r.left) <= 0) continue;
          var gapPx;
          if (b.bottom <= r.top) gapPx = r.top - b.bottom;
          else if (r.bottom <= b.top) gapPx = b.top - r.bottom;
          else gapPx = 0;
          // V7.24.3：合并前过 colonSplitVeto（按上下位置取单元，见其注释）
          var vAbove = (b.top <= r.top) ? bunits[bi] : us;
          var vBelow = (b.top <= r.top) ? us : bunits[bi];
          // V7.24.4：sameScale 漏判（同字号框高噪声）时走 wrappedLineMerge
          // 补充通道（四道约束见其注释）；colonSplitVeto 对两个通道都生效
          var vThresh = Math.max(medH(heights[bi]), medH(hs));
          if (gapPx < vThresh && (sameScale(heights[bi], hs) ||
              wrappedLineMerge(b, bunits[bi], r, us)) &&
              !colonSplitVeto(vAbove, vBelow)) {
            if (r.left < b.left) b.left = r.left;
            if (r.top < b.top) b.top = r.top;
            if (r.right > b.right) b.right = r.right;
            if (r.bottom > b.bottom) b.bottom = r.bottom;
            bunits[bi] = bunits[bi].concat(us);
            heights[bi] = heights[bi].concat(hs);
            placed = true;
            break;
          }
        }
        if (!placed) {
          blocks.push(r);
          bunits.push(us);
          heights.push(hs);
          confs.push(minConf);
        }
      }
      // 顺序贪心可能漏掉间接相邻——多轮合并到不动点
      var merged = true;
      while (merged) {
        merged = false;
        outer:
        for (var i2 = 0; i2 < blocks.length; i2++) {
          for (var j2 = i2 + 1; j2 < blocks.length; j2++) {
            var a = blocks[i2];
            var b2 = blocks[j2];
            if (Math.min(a.right, b2.right) - Math.max(a.left, b2.left) <= 0) continue;
            var gapPx2;
            if (a.bottom <= b2.top) gapPx2 = b2.top - a.bottom;
            else if (b2.bottom <= a.top) gapPx2 = a.top - b2.bottom;
            else gapPx2 = 0;
            // V7.24.3：不动点轮同样受 colonSplitVeto 约束（防链式绕过的否决）
            var v2Above = (a.top <= b2.top) ? bunits[i2] : bunits[j2];
            var v2Below = (a.top <= b2.top) ? bunits[j2] : bunits[i2];
            // V7.24.4：与贪心轮一致——sameScale 或 wrappedLineMerge 放行，
            // 且不过 colonSplitVeto
            var vThresh2 = Math.max(medH(heights[i2]), medH(heights[j2]));
            if (gapPx2 < vThresh2 && (sameScale(heights[i2], heights[j2]) ||
                wrappedLineMerge(a, bunits[i2], b2, bunits[j2])) &&
                !colonSplitVeto(v2Above, v2Below)) {
              if (b2.left < a.left) a.left = b2.left;
              if (b2.top < a.top) a.top = b2.top;
              if (b2.right > a.right) a.right = b2.right;
              if (b2.bottom > a.bottom) a.bottom = b2.bottom;
              bunits[i2] = bunits[i2].concat(bunits[j2]);
              heights[i2] = heights[i2].concat(heights[j2]);
              if (confs[j2] < confs[i2]) confs[i2] = confs[j2];
              blocks.splice(j2, 1);
              bunits.splice(j2, 1);
              heights.splice(j2, 1);
              confs.splice(j2, 1);
              merged = true;
              break outer;
            }
          }
        }
      }
      var out = [];
      for (var oi = 0; oi < blocks.length; oi++) {
        // V7.24.4：块内单元按阅读序重排后拼接（并入顺序会因同行 left 序
        // 与组间 top 序乱序，见 orderBlockUnits 注释）
        var t = unitsText(orderBlockUnits(bunits[oi]), "\n");
        if (t) out.push({
          left: blocks[oi].left,
          top: blocks[oi].top,
          right: blocks[oi].right,
          bottom: blocks[oi].bottom,
          text: t,
          confidence: confs[oi]
        });
      }
      return out;
    };

    // OCR 缓存块匹配（同步，不截图）。缓存过期返回 null。
    app.matchOcrBlocks = function(x, y, textHitPadX, textHitPadY, textSnapSideX, textSnapVertY, textLinePadX) {
      var blocks = this.ocrBlocks;
      if (!blocks || blocks.length === 0) return null;
      var now = nowMs();
      if (now - this.ocrBlocksAt > this.ocrCacheTtl) return null;
      var candidates = [];
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        var r = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
        var hitMode = hitModeForRect(r, x, y, textHitPadX, textHitPadY, textSnapSideX, textSnapVertY, textLinePadX);
        if (hitMode < 0) continue;
        var w = r.right - r.left;
        var h = r.bottom - r.top;
        candidates.push({
          rect: r,
          area: Math.max(1, w * h),
          distance: rectDistanceToPoint(x, y, r),
          centerDistance: rectCenterDistance(x, y, r),
          hitMode: hitMode,
          text: b.text
        });
      }
      if (candidates.length === 0) return null;
      candidates.sort(function(a, b2) {
        if (a.hitMode !== b2.hitMode) return a.hitMode - b2.hitMode;
        if (a.distance !== b2.distance) return a.distance - b2.distance;
        if (a.area !== b2.area) return a.area - b2.area;
        return a.centerDistance - b2.centerDistance;
      });
      var best = candidates[0];
      return {
        rect: best.rect,
        info: best.text,
        className: "OCR",
        packageName: "",
        hitMode: best.hitMode,
        fromOcr: true
      };
    };

    // OCR 兜底：独立线程截图 + OcrDetect，完成后主线程匹配出框。
    // 匹配用 OCR 完成时刻的指针位置（比发起时更新鲜）。
    // 提示：用户路径与预热都弹「启动中…」「识别已就绪」（daemon 线程，
    // 防 executeAction 重入）；保鲜刷新静默；三通道全挂由 SwitchCase 兜底。
    app.runOcrFallback = function(x, y, opts) {
      var self = this;
      opts = opts || {};
      var background = opts.background === true;
      var prewarm = opts.prewarm === true;
      if (this.closed || this.areaModeActive) return;
      // V7.44：弹框即终点。面板已经开着（或截图已落盘正在等面板）时，
      // 不再发起新的截图 + OCR —— 用户只差选字，后台没必要再烧 CPU。
      if (this.panelReached()) { probeLog("OCR_SKIP terminal"); return; }
      if (!HAS_OCR_DETECT || !HAS_OCR_RECTSRC || !HAS_OCR_ANY) return; // 类加载失败则禁用
      if (this.ocrRunning) return;
      var now = nowMs();
      if (now - this.lastOcrTryAt < this.ocrCooldown) return;
      this.lastOcrTryAt = now;
      this.ocrRunning = true;
      // V7.24.1：用户路径「启动中…」改异步 daemon 线程弹送——主线程
      // 调 shortx.executeAction 会与等待 latch 的执行器线程重入死锁，
      // 真机症状：数秒后整个 UI 卡死只能重启系统。
      // V7.24.5：预热路径也弹「启动中…」（对齐 APP「启动中 → 识别
      // 已就绪」全链路，见函数头注 a) 条）。
      // V7.33.3：starting 会话内只弹一次——预热无条件
      // 首弹后，拖动中 OCR 缓存过期（正缓存 30s / 负缓存退避 8~30s）
      // 再次触发的用户路径 OCR 静默跑（真机反馈「拖动一段时间后又显示
      // 启动中…」）；保鲜刷新本就 background 静默，不受影响。
      var thread = new java.lang.Thread(new java.lang.Runnable({ run: function() {
        // V7.33.10：预热/保鲜是「后台暖机」，降到后台
        // 优先级，避免 4 线程截图+OCR 与前台 UI 抢 CPU（真机实测 7.4s，
        // 正好覆盖启动后那几秒）；用户触发的 OCR 保持正常优先级。
        if (background) {
          try { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND); } catch(ePrio) {}
        }
        var blocks = null;
        var shotPath = null;
        try {
          // 1) 全屏截图（母版 captureAreaToFile 同款链路，返回 PNG 路径）
          var full = new android.graphics.Rect(0, 0, self.screenW, self.screenH);
          shotPath = self.captureAreaToFile(full);
          // 2) OcrDetect（diag-3 实证：不设 outputType 默认输出 JSON）
          if (shotPath) {
            var act = OcrDetect.newBuilder()
              .setRectSrc(Any.pack(RectSourcePath.newBuilder().setPath(String(shotPath)).build()))
              .setThreads(4)
              .setUseSlim(false)
              .setSeparator("\n")
              .build();
            var res = shortx.executeAction(act);
            var jsonText = "";
            try { jsonText = String(res.contextData.get("ocrResult") || ""); } catch(eGet) {}
            blocks = self.parseOcrBlocks(jsonText);
          }
        } catch(eOcr) { blocks = null; }
        // V7.31：OCR 输入截图读完即删。executeAction
        // 同步返回即 OcrDetect 已读完文件，此后截图无任何用途——此前
        // 从不删除，会话期间每次 OCR（预热/用户触发/保鲜刷新）都在
        // ShortX 私有目录 data/screenshots 留一份；且用户下次框选截图
        // 时会被导入 case「截图/ocr」的 ShellCommand
        // mv <shortx>/data/screenshots/ 下所有 png 一并搬进相册 DCIM/Screenshots
        // （真机反馈「内部文件夹都会多一份软件截图」）。area_capture
        // 的用户主动截图是平台交付物，不在此删除范围。
        // 判空 + try/catch 双保险：删除失败绝不影响 OCR 结果。
        try {
          if (shotPath) {
            var shotFile = new java.io.File(String(shotPath));
            if (shotFile.exists()) shotFile.delete();
          }
        } catch(eDelShot) {}
        var h = self.handler;
        if (!h) { self.ocrRunning = false; return; }
        h.post(new java.lang.Runnable({ run: function() {
          self.ocrRunning = false;
          if (self.closed) return;
          // V7.44：弹框即终点。OCR 在后台要跑 2~4s，回到主线程时用户很可能
          // 已经松手弹框（取证模式），或者已经截完图、正在等选字面板
          // （截图模式）。这时候写缓存、回填 currentText、弹「识别已就绪」
          // 全是多余的 —— 后面只剩「挑字 → 是否复制」，一步都不该再自动做。
          if (self.panelReached()) {
            probeLog("OCR_ABORT_PANEL prewarm=" + (prewarm ? 1 : 0) +
                     " bg=" + (background ? 1 : 0));
            return;
          }
          // V7.24.5：缓存记账（含空结果负缓存 + 退避 + 诊断计数），
          // 见 recordOcrResult——空结果也必须落缓存，否则 miss 路径
          // 会背靠背重跑（云闪付首页卡顿根因）
          self.recordOcrResult(blocks);
          // V7.24.1：OCR 完成反馈（异步 daemon 线程弹送，防主线程
          // executeAction 死锁）。用户触发路径（等了 2~4s 的那次）仅
          // 非空结果反馈（空结果不误导）；保鲜刷新静默；
          // 预热路径无论有无文字都弹「识别已就绪」给「启动中…」收尾
          // （V7.25 无条件化；V7.26 起彻底无条件——不再因用户预热在途
          // 时已自行取到字而抑制，真机反馈「偶尔不弹」即该抑制条件所致；
          // 会话在预热完成前关闭时本回调被 closed 拦截，不会补弹）。
          // V7.33.1：ready/ocr_done 双码合并为 ready 单码——用户路径非空结果由 ocr_done 改走 ready，两条路径共用
          // 「识别已就绪」一句反馈；ocr_done 码与导入侧「OCR完成兜底」
          // case 一并移除（case 6→5）。
          // V7.43：全脚本唯一的吐司。首次预热成功、或用户路径拿到块时弹一次。
          // V7.44：弹框之后一句都不补。上面的入口守卫已经拦过一次，这里
          // 再判一次 —— recordOcrResult 与 applyInspectResult 都在同一消息里，
          // 状态理论上不会变，但这条吐司是用户唯一能听见的声音，宁可多看
          // 一眼状态，也不要让它在卡片上再响一次。
          // V7.66：这里原来会弹「识别已就绪」。吐司全部移到 ShortX 指令链，
          // 脚本不再有自己的 UI 通道 —— 少一条通道，就少一处"会不会卡住"的
          // 悬念。面板出现本身就是"已就绪"最直接的反馈。
          // V7.33.2：OCR 完成回调不覆盖已有 a11y
          // 拾取——用户当前正指着 a11y 命中的文字（currentText 非空
          // 且 currentPickClassName 非 OCR）时，即便 hotspot 处 OCR
          // 块命中，也只留缓存不 apply：桌面真机反馈 a11y 正常分开
          // 「图标+两段文字」，OCR 就绪后被合并成一行，即该无条件
          // apply 所致（第三条路径）；当前无 a11y 拾取（空白区/OCR
          // 独立场景）时照常 apply——a11y 零命中的图片文字不受影响。
          if (blocks && blocks.length > 0) {
            var hp = self.hotspot();
            var hit = self.matchOcrBlocks(hp.x, hp.y, self.textHitPadX, self.textHitPadY, self.textSnapSideX, self.textSnapVertY, self.textLinePadX);
            if (hit && (!self.currentText || self.currentPickClassName === "OCR")) {
              self.ocrMissCount = 0;
              self.applyInspectResult(hit);
            }
          }
        }}));
      }}));
      try { thread.start(); } catch(eStart) { this.ocrRunning = false; }
    };

    // V7.24.5：OCR 结果记账——缓存写入 + 空结果负缓存退避 + 诊断计数。
    // 必须在主线程调用（runOcrFallback 完成回调里）。空结果/失败也按
    // 「当前屏幕无可识别文字」负缓存（ocrBlocks=[]），根因：旧逻辑空
    // 结果不写缓存，noteOcrMiss 的缓存检查永不成立——一次 OCR 完成
    // （真机 2~4s）后隔 2 次 miss（~160ms）冷却已过立即再跑，整场会话
    // 背靠背满占 CPU（截图 + 4 线程 PaddleOCR），真机反馈「云闪付首页
    // 识别特别卡顿」。负缓存 TTL 按连续空结果次数退避
    // （effectiveCacheTtl：8s→16s→30s 封顶）——首次空结果快速重试
    // 一次（防瞬时故障误判），持续无字则收敛到与成功缓存同频；非空
    // 结果重置退避。[] 为真值，DOWN 保鲜刷新对负缓存同样生效（用户
    // 按下即意图识别，换屏后一次按下即可恢复，无需等 TTL）。
    app.recordOcrResult = function(blocks) {
      var now = nowMs();
      if (blocks && blocks.length > 0) {
        this.ocrBlocks = blocks;
        this.ocrBlocksAt = now;
        this.ocrEmptyStreak = 0;
      } else {
        this.ocrBlocks = [];
        this.ocrBlocksAt = now;
        this.ocrEmptyStreak = (this.ocrEmptyStreak || 0) + 1;
      }
    };

    // V7.24.5：当前缓存的有效 TTL。负缓存（空结果）按连续空结果次数
    // 退避：第 1 次空 → 8s 后重试（可能是瞬时故障），第 2 次 → 16s，
    // 第 3 次起 → 30s（封顶同成功缓存 ocrCacheTtl）——持久无字/截图
    // 失败页面收敛到低频轮询，不再烧 CPU。非空缓存恒为 ocrCacheTtl。
    app.effectiveCacheTtl = function() {
      if (this.ocrBlocks && this.ocrBlocks.length === 0) {
        var streak = this.ocrEmptyStreak || 0;
        if (streak >= 3) return this.ocrCacheTtl;
        return this.ocrEmptyCacheTtl * Math.pow(2, Math.max(0, streak - 1));
      }
      return this.ocrCacheTtl;
    };

    // a11y 未命中计数 + 触发调度（由 applyInspectResult 未命中分支调用）
    // V7.24.2：缓存有效期内不再因 miss 重复触发 OCR。根因：微信等 OCR
    // 场景 a11y 全路径零命中，用户每移动一下指针都是一次 miss，旧逻辑
    // 「miss 计数达标 + 700ms 冷却」就会重跑一次完整 OCR（真机 2~4s），
    // 「启动中…」「OCR 识别完成」交替轰炸（真机复现）。缓存即当前屏幕
    // 的识别结果，miss 只代表指针处无文字；内容更新走 DOWN 保鲜刷新
    // （年龄 >ocrRefreshMinAge）与会话结束丢弃，语义与 APP 一致。
    // V7.24.5：负缓存（OCR 空结果，ocrBlocks=[]）同样享受缓存门，TTL 走
    // effectiveCacheTtl 退避（8s→16s→30s）——否则空结果页面 OCR 一完成
    // 就被 miss 立即重跑，整场会话背靠背满占 CPU（云闪付首页卡顿根因）。
    app.noteOcrMiss = function() {
      // V7.44：弹框即终点，面板开着时不再累计 miss、不再触发新 OCR。
      if (this.closed || this.areaModeActive || this.panelReached()) return;
      var now0 = nowMs();
      if (this.ocrBlocks && now0 - this.ocrBlocksAt <= this.effectiveCacheTtl()) {
        this.ocrMissCount = 0;
        return;
      }
      this.ocrMissCount++;
      var now = nowMs();
      if (this.ocrMissCount >= this.ocrMissTrigger &&
          now - this.lastOcrTryAt >= this.ocrCooldown &&
          !this.ocrRunning) {
        this.ocrMissCount = 0;
        this.runOcrFallback(this.lastQueryX, this.lastQueryY);
      }
    };


    // V7.25：a11y 通道实效判定——本次会话 a11y 查询是否至少命中过一次。
    // 取代 V7.23~V7.24.5 的 probeA11yFast 树探测（根因：云闪付首页树里
    // 有底部 tab 等标准 TextView，探测判「a11y 可用」→ 不预热不保鲜；
    // 但正文是自绘文字 a11y 查不到 → 悬停全靠 2~4s OCR 慢路）。探测只能
    // 回答「树里有没有文字节点」，实效直接回答「a11y 能不能服务本次
    // 会话」：命中过即有效（微信等页面毫秒级出框，零 OCR 浪费）；从未
    // 命中（云闪付/游戏/Canvas 类页面）则 OCR 缓存是唯一通道，DOWN 借机
    // 保鲜保持新鲜。OCR 命中不计入（那正是 a11y 无效的证据）。
    app.a11yEffective = function() {
      return (this.a11yHits || 0) > 0;
    };

    // V7.23：OCR 缓存保鲜刷新（对齐 APP maybeRefreshOcrInBackground）。
    // 调用时机：DOWN（用户每次按下取字都借机校准）。条件：a11y 本会话
    // 从未命中（a11yEffective，V7.25 起取代探测——见其头注）+ 缓存已
    // 建立（ocrBlocks 非 null；V7.24.5 起空结果负缓存 [] 同样会刷新——
    // 用户 DOWN 即意图识别，无字页面换屏后一次按下即可恢复，不必等负
    // 缓存 TTL）+ 年龄 > ocrRefreshMinAge(1.5s)。刷新在后台串行进行
    // （ocrRunning 防叠加），本次查询照常走缓存快路出结果；刷新完成时
    // runOcrFallback 按当前指针位置重新匹配并 applyInspectResult——
    // 高亮框自动校正到最新内容（背景路径不弹 Toast）。V7.25 起探测移除
    // 后本函数全部为主线程字段判定（无树遍历），直接在 DOWN 处理器同步
    // 调用，不再起线程。
    app.maybeRefreshOcrInBackground = function() {
      // V7.44：弹框即终点，面板开着时不做保鲜刷新（截图已落盘同理）。
      if (this.closed || this.areaModeActive || this.panelReached()) return;
      if (!HAS_OCR_DETECT || !HAS_OCR_RECTSRC || !HAS_OCR_ANY) return;
      if (this.ocrRunning) return;
      if (!this.ocrBlocks) return;
      if (this.a11yEffective()) return; // a11y 已实证有效，无需 OCR 保鲜
      var now = nowMs();
      if (now - this.ocrBlocksAt <= this.ocrRefreshMinAge) return;
      this.runOcrFallback(-1, -1, { background: true });
    };

    // V7.23：会话开始 OCR 预热（对齐 APP startPrewarmIfNeeded）。
    // 箭头已可见（build 尾部延迟 ocrPrewarmDelay 调用）→ 后台 OCR 预热，
    // 与用户瞄准时间重叠——首次悬停不必再等一次完整截图+识别（真机
    // 2~4s）。完成弹「识别已就绪」（APP 同款文案；V7.24.5 起启动时也弹
    // 「启动中…」，全链路对齐 APP；V7.25 起无论有无文字都弹 ready 给
    // 「启动中…」收尾，V7.26 起彻底无条件——不再因用户已自行取到字而
    // 抑制，真机反馈「偶尔不弹」即该抑制条件所致）。
    // V7.25：预热无条件化（原 probeA11yFast 门控移除）——根因：任意
    // 界面启动脚本若不触摸屏幕就全程静默（有文字节点的界面都判「a11y
    // 可用」跳过预热），且云闪付类「树里有文字节点但正文自绘」的界面
    // 因此没有热缓存，悬停全靠 OCR 慢路（黄框很慢）。无条件预热后：
    // 脚本一启动即跑（启动中…→识别已就绪），悬停走缓存快路即时出框；
    // a11y 完好的页面这次预热同时是「a11y 未命中区域」（图片文字等）
    // 的兜底缓存。预热结果为空的页面（V7.24.5 负缓存 ocrBlocks=[]）
    // 同样视为已缓存，不重复预热——由 effectiveCacheTtl 退避控制 miss
    // 路径重试节奏。
    // V7.26：完成提示无条件化——预热完成即弹「识别已就绪」（不再有
    // readyTipPending 待定/抑制逻辑，用户已自行取到字也照弹，对齐
    // 「启动中…→识别已就绪」每次可见的预期；会话提前关闭则完成回调
    // 被 closed 拦截不弹）。
    // V7.33.10：两段式预热决策（纯函数，便于单测）。
    // a11y 已实证可用（本次会话命中过）→ 再等 3500ms（多数会话已结束，
    // 7s 级截图+OCR 不必跑）；从未命中（自绘/Canvas 页面）→ 0，立即预热。
    app.nextPrewarmPlan = function(a11yHits) {
      return (Number(a11yHits) || 0) > 0 ? 3500 : 0;
    };

    app.startOcrPrewarm = function() {
      if (this.closed) return;
      if (!HAS_OCR_DETECT || !HAS_OCR_RECTSRC || !HAS_OCR_ANY) return;
      if (this.ocrBlocks) return; // 已有缓存无需预热
      if (this.ocrRunning) return; // 用户路径 OCR 在途，不叠加
      this.runOcrFallback(-1, -1, { background: true, prewarm: true });
    };

    app.frameDrawable = function(state) {
      var frameRadius = 4;
      // V7.34：填充色原来是 0x1822c55e / 0x14f59e0b，alpha 分别是 0x18 / 0x14。
      // crash 日志里的 "Invalid ID: 24" 正好是 0x18 —— Paint.setColor 会把
      // int 颜色的高 8 位当 ColorSpace id 去查表，查不到就抛异常，而这里是
      // system_server，异常没人接就是软重启。改成全透明填充只留 2dp 描边。
      if (state === 2) return makeStrokeBg(0x00000000, 0xff22c55e, 2, frameRadius);
      return makeStrokeBg(0x00000000, 0xfff59e0b, 2, frameRadius);
    };

    app.frameStateNow = function() {
      return (this.currentText && this.currentTextRect) ? 1 : 0;
    };

    app.applyFrameState = function(state, animate) {
      if (!this.frame || state <= 0) return;
      if (this.lastFrameState === state) return;
      this.lastFrameState = state;
      try { this.frame.setBackgroundDrawable(this.frameDrawable(state)); } catch(eBg) {}
      if (!animate) return;
      try {
        this.frame.animate().cancel();
        this.frame.setAlpha(0.82);
        this.frame.setScaleX(0.985);
        this.frame.setScaleY(0.985);
        this.frame.animate().alpha(0.94).scaleX(1).scaleY(1).setDuration(110).start();
      } catch(eAnim) {}
    };

    // V7.32：hover debounce 状态机已废弃（V7.24 提示链路 + V7.26 短记忆
    // 取代早期悬停稳定/就绪延迟机制），仅保留 hot 复位语义
    app.resetHoverDebounce = function(clearKey) {
      this.hot = false;
    };

    app.updateHotState = function(animate) {
      var oldHot = this.hot;
      this.hot = !!(this.currentText && this.currentTextRect);
      if (oldHot !== this.hot) {
        try { if (this.pointer) this.pointer.invalidate(); } catch(ePointer) {}
        this.applyFrameState(this.frameStateNow(), !!animate);
      } else {
        this.applyFrameState(this.frameStateNow(), false);
      }
      return this.hot;
    };

    app.showFrame = function(rect, text) {
      if (!rect) return;
      var key = rect.left + "," + rect.top + "," + rect.right + "," + rect.bottom;
      var expandedW = Math.max(dp(1), rect.right - rect.left + this.frameExpand * 2);
      var expandedH = Math.max(dp(1), rect.bottom - rect.top + this.frameExpand * 2);
      var fx = rect.left - this.frameExpand;
      var fy = rect.top - this.frameExpand;
      if (!this.frame) {
        this.frame = new android.widget.FrameLayout(context);
        this.frame.setBackgroundDrawable(this.frameDrawable(this.frameStateNow()));
        this.frame.setAlpha(0);
        this.frame.setScaleX(0.985);
        this.frame.setScaleY(0.985);
        this.frame.setClickable(false);
        this.frame.setFocusable(false);
        this.frameLp = new android.view.WindowManager.LayoutParams(expandedW, expandedH, android.view.WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, android.view.WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | android.view.WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE | android.view.WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN, android.graphics.PixelFormat.TRANSLUCENT);
        this.frameLp.gravity = android.view.Gravity.TOP | android.view.Gravity.START;
        this.frameLp.x = fx;
        this.frameLp.y = fy;
        try { this.wm.addView(this.frame, this.frameLp); this.frame.animate().alpha(0.94).scaleX(1).scaleY(1).setDuration(140).start(); } catch(e0) { this.frame = null; }
      } else if (key !== this.lastRectKey) {
        this.frameLp.width = expandedW;
        this.frameLp.height = expandedH;
        this.frameLp.x = fx;
        this.frameLp.y = fy;
        try { this.wm.updateViewLayout(this.frame, this.frameLp); } catch(e1) {}
        try { this.frame.setAlpha(0.86); this.frame.animate().alpha(0.94).setDuration(110).start(); } catch(eMoveAnim) {}
      }
      this.lastRectKey = key;
      this.applyFrameState(this.frameStateNow(), true);
    };

    // V7.34：面板打开期间只让命中框"隐身"，不动它的窗口。
    // hideFrame() 会 removeViewImmediate 同步拆掉命中框窗口，而紧接着就要
    // 展示面板 —— 一个时间片里同时"销毁一个 overlay"和"出现新内容"，
    // 是最容易把窗口系统拖进互等的组合。这里只改 alpha，收尾时 close() 一起拆。
    app.hideFrameSoft = function() {
      var f = this.frame;
      if (!f) return;
      try { f.animate().cancel(); } catch(eH0) {}
      try { f.setAlpha(0); } catch(eH1) {}
      try { f.setClickable(false); } catch(eH2) {}
    };

    app.hideFrame = function() {
      var old = this.frame;
      this.frame = null;
      this.lastRectKey = "";
      this.lastFrameState = -1;
      if (!old) return;
      try {
        var self = this;
        // V7.34：removeViewImmediate → removeView（异步 die），同步销毁
        // ViewRootImpl/InputChannel 会把工作压在当前这一帧里。
        old.animate().alpha(0).setDuration(150).withEndAction(new JavaAdapter(java.lang.Runnable, { run: function() {
          try { self.wm.removeView(old); } catch(e0) {}
        }})).start();
      } catch(e1) {
        try { this.wm.removeView(old); } catch(e2) {}
      }
    };

    app.textKeyOf = function(result) {
      if (!result || !result.rect || !result.info) return "";
      var r = result.rect;
      return r.left + "," + r.top + "," + r.right + "," + r.bottom + ":" + String(result.info);
    };

    app.hideTextPanel = function() {
      var old = this.textPanel;
      this.textPanel = null;
      if (!old) return;
      try {
        var self = this;
        old.animate().alpha(0).setDuration(150).withEndAction(new JavaAdapter(java.lang.Runnable, { run: function() {
          try { self.wm.removeViewImmediate(old); } catch(e0) {}
        }})).start();
      } catch(e1) {
        try { this.wm.removeViewImmediate(old); } catch(e2) {}
      }
    };

    app.removePointerOverlayNow = function() {
      try { this.removeAreaFrameNow(); } catch(eAreaRemove) {}
      try { this.resetAreaState(); } catch(eAreaReset) {}
      var wm0 = this.wm;
      var oldFrame = this.frame;
      var oldPanel = this.textPanel;
      this.frame = null;
      this.frameLp = null;
      this.textPanel = null;
      this.lastRectKey = "";
      this.lastFrameState = -1;
      try { if (oldFrame) oldFrame.animate().cancel(); } catch(e0) {}
      try { if (oldPanel) oldPanel.animate().cancel(); } catch(e1) {}
      try { if (wm0 && oldFrame) wm0.removeViewImmediate(oldFrame); } catch(e2) {
        try { if (wm0 && oldFrame) wm0.removeView(oldFrame); } catch(e3) {}
      }
      try { if (wm0 && oldPanel) wm0.removeViewImmediate(oldPanel); } catch(e4) {
        try { if (wm0 && oldPanel) wm0.removeView(oldPanel); } catch(e5) {}
      }
    };

    // ---- 重置空闲超时计时器（V7.0：改为单个 Handler 延时任务）----
    app.resetAreaIdleTimer = function() {
      if (!this.areaHasBeenDragged || !this.areaModeActive || this.closed) return;
      if (!this.handler) return;
      // V7.77：这个 Runnable 以前每次重置都 new 一个（拖动中每个跨阈值的
      // MOVE 都会重置一次），JavaAdapter 造对象在解释器里不算便宜。惰性建
      // 一次、之后反复 remove/post 同一个 —— 语义完全一样。
      var tick = this.areaIdleRunnable;
      if (!tick) {
        var self = this;
        tick = new java.lang.Runnable({ run: function() {
          if (self.areaModeActive && !self.closed && self.areaHasBeenDragged) {
            // 空闲超时退出：与"第二根手指取消"走同一条返回取字序列（无 Toast 反馈，保持原行为）
            self.returnToTextPickFromArea();
          }
        }});
        this.areaIdleRunnable = tick;
      }
      try { this.handler.removeCallbacks(tick); } catch(e) {}
      try { this.handler.postDelayed(tick, this.areaIdleDelay); } catch(ePost) {}
    };

    // ---- 从框选态返回指针取字态（第二根手指取消 / 空闲超时共用）----
    // V7.43：不再接受/弹任何提示文案，静默回到取字态。
    app.returnToTextPickFromArea = function() {
      if (this.closed) return;
      this.cancelAreaMode();
      this.resetHoverDebounce(true);
      this.currentText = "";
      this.currentTextRect = null;
      this.hot = false;
      this.hideFrame();
      this.scheduleInspect(true);
    };

    app.cancelAreaMode = function() {
      this.areaHasBeenDragged = false;
      this.lastStableMoveX = 0;
      this.lastStableMoveY = 0;
      if (this.areaIdleRunnable && this.handler) {
        try { this.handler.removeCallbacks(this.areaIdleRunnable); } catch(e) {}
      }
      this.areaIdleRunnable = null;
      this.removeAreaFrameNow();
      this.removeAreaCancelCatcher();
      this.resetAreaState();
    };

    app.startAreaHoldCandidate = function(session) {
      if (this.closed || !this.dragging || this.areaModeActive) return;
      var hp = this.hotspot();
      this.areaHoldAnchorX = hp.x;
      this.areaHoldAnchorY = hp.y;
      this.areaHoldToken++;
      this.scheduleAreaHoldCheck(session, this.areaHoldToken);
    };

    app.updateAreaHoldCandidate = function(px, py) {
      if (this.closed || !this.dragging || this.areaModeActive) return;
      var hp = this.hotspotFromPointerXY(px, py);
      if (this.areaHoldAnchorX < -90000 || this.areaHoldAnchorY < -90000) {
        this.startAreaHoldCandidate(this.dragSession);
        return;
      }
      var dx = hp.x - this.areaHoldAnchorX;
      var dy = hp.y - this.areaHoldAnchorY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      // V7.22（对齐 APP V7.23 原样移植）：任何可感知移动（>3dp）都重置
      // 悬停锚点与计时——只有真正静止累计 1.5 秒才进框选。旧实现在
      // 5~14dp 区间有「锚点 25% 渐进跟随」，慢速持续移动时锚点永远追着
      // 指针、距离始终 ≤14dp，用户慢移箭头会突然变成框选态（已移除）。
      // 3dp 容差只防触摸抖动，不吞慢移。
      if (dist > this.areaHoldStableSlop) {
        this.startAreaHoldCandidate(this.dragSession);
        return;
      }
    };

    app.scheduleAreaHoldCheck = function(session, token) {
      if (!this.handler) return;
      var self = this;
      this.handler.postDelayed(new java.lang.Runnable({ run: function() {
        try {
          if (self.closed || !self.dragging || self.areaModeActive) return;
          if (session !== self.dragSession) return;
          if (token !== self.areaHoldToken) return;
          var hp = self.hotspot();
          var dx = hp.x - self.areaHoldAnchorX;
          var dy = hp.y - self.areaHoldAnchorY;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist <= self.areaHoldBreakSlop) self.enterAreaMode();
          else self.startAreaHoldCandidate(session);
        } catch(eAreaHold) {}
      }}), this.areaHoldDelay);
    };

    app.enterAreaMode = function() {
      if (this.areaModeActive || this.closed) return;
      var hp = this.hotspot();
      this.areaModeActive = true;
      this.areaHasBeenDragged = false;
      this.lastStableMoveX = this.pointerLp.x;
      this.lastStableMoveY = this.pointerLp.y;
      this.areaStartX = Math.round(hp.x);
      this.areaStartY = Math.round(hp.y);
      this.areaEndX = this.areaStartX;
      this.areaEndY = this.areaStartY;
      this.currentText = "";
      this.currentTextRect = null;
      this.currentTextKey = "";
      this.currentPickClassName = "";
      this.currentPickPackageName = "";
      this.currentPickHitMode = -1;
      this.lastValidPickText = "";
      this.lastValidPickRect = null;
      this.lastValidPickKey = "";
      this.lastValidPickClassName = "";
      this.lastValidPickPackageName = "";
      this.lastValidPickHitMode = -1;
      this.lastValidPickTime = 0;
      this.hot = false;
      this.pickTriggered = false;
      try { this.hideFrame(); } catch(e0) {}
      try { if (this.pointer) this.pointer.invalidate(); } catch(e1) {}
      this.showAreaFrame();
      // 第二根手指点击取消框选用的全屏捕获窗（须在框选框之后添加，保证位于其上层）
      this.showAreaCancelCatcher();
    };

    app.getAreaRect = function() {
      var l = Math.min(this.areaStartX, this.areaEndX);
      var t = Math.min(this.areaStartY, this.areaEndY);
      var r = Math.max(this.areaStartX, this.areaEndX);
      var b = Math.max(this.areaStartY, this.areaEndY);
      l = clamp(Math.round(l), 0, this.screenW);
      r = clamp(Math.round(r), 0, this.screenW);
      t = clamp(Math.round(t), 0, this.screenH);
      b = clamp(Math.round(b), 0, this.screenH);
      return { left: l, top: t, right: r, bottom: b, width: Math.max(1, r - l), height: Math.max(1, b - t) };
    };

    app.getAreaVisualRect = function() { return this.getAreaRect(); };

    app.getAreaCaptureRect = function() {
      var v = this.areaFrozenVisualRect ? this.areaFrozenVisualRect : this.getAreaVisualRect();
      var inset = Math.round(this.areaCaptureInset || dp(3));
      var l = clamp(Math.round(v.left + inset), 0, this.screenW);
      var t = clamp(Math.round(v.top + inset), 0, this.screenH);
      var r = clamp(Math.round(v.right - inset), 0, this.screenW);
      var b = clamp(Math.round(v.bottom - inset), 0, this.screenH);
      if (r <= l) r = l + 1;
      if (b <= t) b = t + 1;
      return { left: l, top: t, right: r, bottom: b, width: Math.max(1, r - l), height: Math.max(1, b - t) };
    };

    app.createAreaFrameView = function() {
      var self = this;
      var AreaFrameView = JavaAdapter(android.view.View, {
        onDraw: function(canvas) {
          try {
            if (!self.areaModeActive && !self.areaCapturing) return;
            // V7.77：读缓存，不调 getAreaVisualRect()。那个函数每次返回一个
            // 新对象，而这里有 60~120Hz。areaDrawnRect 由 showAreaFrame 在
            // 提交脏区之前写好，与这次要画的框必然是同一个。
            var rect = self.areaFrozenVisualRect || self.areaDrawnRect;
            if (!rect || rect.width < 1 || rect.height < 1) return;
            var p = self.paint;
            p.setAntiAlias(true);
            try { p.setShader(null); p.clearShadowLayer(); } catch(e0) {}
            p.setStyle(android.graphics.Paint.Style.STROKE);
            p.setStrokeWidth(self.areaStrokeW);
            p.setStrokeCap(android.graphics.Paint.Cap.SQUARE);
            p.setStrokeJoin(android.graphics.Paint.Join.MITER);
            paintArgb(p, 245, 99, 102, 241);
            canvas.drawRect(rect.left, rect.top, rect.right, rect.bottom, p);
          } catch(eDrawArea) {}
        }
      }, context);
      try { AreaFrameView.setWillNotDraw(false); } catch(eWill) {}
      // V7.0：改为硬件加速层（全屏软件层每帧整屏重绘是框选卡顿主因之一）
      AreaFrameView.setClickable(false);
      AreaFrameView.setFocusable(false);
      return AreaFrameView;
    };

    app.showAreaFrame = function() {
      if (!this.areaModeActive || this.closed || !this.wm) return;
      if (!this.areaFrame) {
        this.areaFrame = this.createAreaFrameView();
        this.areaFrameLp = new android.view.WindowManager.LayoutParams(
          this.screenW, this.screenH,
          android.view.WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
          android.view.WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE |
          android.view.WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE |
          android.view.WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN |
          android.view.WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
          android.graphics.PixelFormat.TRANSLUCENT
        );
        this.areaFrameLp.gravity = android.view.Gravity.TOP | android.view.Gravity.START;
        this.areaFrameLp.x = 0;
        this.areaFrameLp.y = 0;
        try { this.wm.addView(this.areaFrame, this.areaFrameLp); } catch(e0) {
          this.areaFrame = null;
          this.areaFrameLp = null;
          return;
        }
      }
      // ===== V7.77：脏区只给「旧框 ∪ 新框」，不再整屏重绘 =====
      // 旧实现每帧 view.invalidate() 无参 —— 一个 1080x2400 的全屏层，
      // 60fps 下等于每秒把整屏重画 60 次。框选框实际只占其中一条边，
      // 其余像素的 alpha 全是 0。改成两次带参 invalidate：一次擦旧框、
      // 一次画新框，Android 会把两个脏区并起来提交给合成器。
      var cur = null;
      try { cur = this.getAreaRect(); } catch(eR) { cur = null; }
      var prev = this.areaDrawnRect;
      if (cur && prev && prev.left === cur.left && prev.top === cur.top &&
          prev.right === cur.right && prev.bottom === cur.bottom) {
        // 手指抖了但没跨过一个像素：什么都不用画
        return;
      }
      this.areaDrawnRect = cur;
      var pad = this.areaStrokePad;
      // prev 为空 = 这一层里现在是什么内容不确定（刚 addView，或刚从
      // INVISIBLE 复位）—— 整屏来一帧，之后每帧都只脏两条边。
      if (!prev) {
        try {
          if (!this.areaFrame) return;
          if (android.os.Build.VERSION.SDK_INT >= 16) this.areaFrame.postInvalidateOnAnimation();
          else this.areaFrame.invalidate();
        } catch(e1) {
          try { this.areaFrame.invalidate(); } catch(e2) {}
        }
        return;
      }
      try {
        if (!this.areaFrame || !cur) return;
        if (android.os.Build.VERSION.SDK_INT >= 16) {
          // 先擦旧位置（否则框拖走以后原地留一条蓝边），再画新位置。
          // 两次带参 invalidate 各自生成一个脏区，Android 会并成一个
          // 外接矩形提交 —— 拖得越远并集越大，最坏退化成整屏，不会更差。
          this.areaFrame.postInvalidateOnAnimation(
            prev.left - pad, prev.top - pad, prev.right + pad, prev.bottom + pad);
          this.areaFrame.postInvalidateOnAnimation(
            cur.left - pad, cur.top - pad, cur.right + pad, cur.bottom + pad);
        } else {
          this.areaFrame.invalidate();
        }
      } catch(e1) {
        try { this.areaFrame.invalidate(); } catch(e2) {}
      }
    };

    app.removeAreaFrameNow = function() {
      var old = this.areaFrame;
      this.areaFrame = null;
      this.areaFrameLp = null;
      this.areaDrawnRect = null;   // V7.77：框没了，脏区基准一起清
      try {
        if (old) {
          old.animate().cancel();
          old.setVisibility(android.view.View.INVISIBLE);
          old.setAlpha(0);
        }
      } catch(e0) {}
      try { if (old && this.wm) this.wm.removeViewImmediate(old); } catch(e1) {
        try { if (old && this.wm) this.wm.removeView(old); } catch(e2) {}
      }
    };

    // ============================================================
    // 框选态：第二根手指点击取消（全屏透明可触控捕获窗）
    // 原理：拖动框选的那根手指，其 DOWN 已归属指针窗口，整个手势都会
    // 继续留在指针窗口；另一根手指产生的是全新手势，其 DOWN 会派发给
    // 最上层的可触控窗口——即本捕获窗。收到 DOWN 即取消框选并消费事件。
    // ============================================================
    app.createAreaCancelCatcherView = function() {
      var self = this;
      var CatcherView = JavaAdapter(android.view.View, {
        onDraw: function(canvas) {
          // 完全透明，仅用于接收触摸事件
        }
      }, context);
      try { CatcherView.setWillNotDraw(true); } catch(eWill) {}
      try { CatcherView.setClickable(true); } catch(e1) {}
      try { CatcherView.setFocusable(false); } catch(e2) {}
      return CatcherView;
    };

    app.showAreaCancelCatcher = function() {
      if (!this.areaModeActive || this.closed || !this.wm) return;
      if (this.areaCancelCatcher) return;
      var catcher = this.createAreaCancelCatcherView();
      var lp = new android.view.WindowManager.LayoutParams(
        this.screenW, this.screenH,
        android.view.WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        // 注意：不加 FLAG_NOT_TOUCHABLE，否则收不到第二根手指的点击
        android.view.WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE |
        android.view.WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN |
        android.view.WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        android.graphics.PixelFormat.TRANSLUCENT
      );
      lp.gravity = android.view.Gravity.TOP | android.view.Gravity.START;
      lp.x = 0;
      lp.y = 0;
      var self = this;
      catcher.setOnTouchListener(new JavaAdapter(android.view.View.OnTouchListener, {
        onTouch: function(v, event) {
          try {
            var action = event.getActionMasked();
            // V7.35：本窗在框选态是最上层的可触窗口，截图后的选字面板挂在
            // 它下面的监视窗上 —— 不放行的话面板一个点击都收不到。
            // 面板判定用的是屏幕坐标，本窗全屏贴在 (0,0)，坐标直接可用。
            if (self.selectPanelInfo) {
              try { self.handleSelectPanelTouch(event); } catch(ePh) {}
              return true;
            }
            // V7.35：OCR 期间点一下 = 别等了，直接交付截图。
            if (action === android.view.MotionEvent.ACTION_DOWN && self.areaOcrRunning) {
              probeLog("AREA_OCR_USER_SKIP");
              self.areaOcrRunning = false;
              try {
                self.handler.postDelayed(new java.lang.Runnable({ run: function() {
                  try { self.finishAreaResult("", { keep: true }); } catch(eSkip) {}
                }}), 48);
              } catch(eSkipPost) {}
              return true;
            }
            if (action === android.view.MotionEvent.ACTION_DOWN) {
              self.cancelAreaModeBySecondFinger();
              return true; // 消费点击，不穿透到下层应用
            }
            if (action === android.view.MotionEvent.ACTION_MOVE ||
                action === android.view.MotionEvent.ACTION_UP ||
                action === android.view.MotionEvent.ACTION_CANCEL) {
              return true; // 后续事件一并消费，避免穿透
            }
            return false;
          } catch(eTouch) { return false; }
        }
      }));
      try {
        this.wm.addView(catcher, lp);
        this.areaCancelCatcher = catcher;
      } catch(eAdd) {
        // 添加失败不影响框选本身（只是没有第二根手指取消能力）
        this.areaCancelCatcher = null;
      }
    };

    app.removeAreaCancelCatcher = function() {
      var old = this.areaCancelCatcher;
      this.areaCancelCatcher = null;
      try { if (old) old.setOnTouchListener(null); } catch(e0) {}
      try { if (old && this.wm) this.wm.removeViewImmediate(old); } catch(e1) {
        try { if (old && this.wm) this.wm.removeView(old); } catch(e2) {}
      }
    };

    // ============================================================
    // V7.19：取字态多指退出——四信号检测（指针窗与全屏监视窗共用）
    // 信号 1（任意 action，getPointerCount()>=2）：本窗口同时持有两根
    //   及以上手指——双指都落在同一个窗口上时必然成立。
    // 信号 2（ACTION_POINTER_DOWN）：本窗口已持有某根手指（拖动/按住
    //   箭头，或监视窗持有第一根窗外手指）时，第二根手指在屏幕任意位置
    //   按下——同一手势的 POINTER_DOWN 只会派发给持有指针的窗口，输入
    //   分发层保证，与 ROM 无关。
    // 信号 3（ACTION_DOWN 且 getDownTime() < getEventTime()）：本窗口
    //   未持有该手势的任何指针（手势开始于本窗获得首个指针之前——例如
    //   启动脚本前手指已按住屏幕，手势归属下层应用窗），此时第二根手指
    //   落在本窗可触区域时，派发下来的是一个孤立的 ACTION_DOWN
    //   （pointerCount==1，V7.17 因此漏判）。在 Android ≤12 上该 split
    //   事件保留原手势 downTime（早于本事件的 eventTime），据此识别
    //   "这是某根更早按下的手指之后又按下的手指"→ 多指 → 退出。
    // 信号 4（ACTION_DOWN 且 getPointerId(0) != 0）：Android 13+ 的
    //   InputDispatcher 把 split 事件的 downTime 设为第二指自己的
    //   eventTime（firstDownTimeInTarget = entry.eventTime，见
    //   prepareDispatchCycleLocked/splitMotionEvent），信号 3 在新系统
    //   必然失效；但 splitMotionEvent 只做指针子集拷贝、保留原手势的
    //   指针 ID——新手势的首指必然 ID 0，后续手指 ID>=1，因此本信号是
    //   跨版本可靠的"第二指"判据。单指场景的 DOWN 必然 pointerId==0
    //   （含手指从其他窗口滑入本窗的 slipping 场景，首指 ID 仍为 0），
    //   不会误触发。
    // 单指操作全程不触发：新手势的 DOWN 必然 pointerId==0、
    // downTime==eventTime、pointerCount==1，也不会出现 POINTER_DOWN。
    // ============================================================
    app.checkMultiTouchExit = function(ev) {
      if (this.closed) return false;
      var mtCount = 1;
      try { mtCount = Number(ev.getPointerCount()); } catch(eMtCount) {}
      if (mtCount >= 2) return true;
      var mtAction = -1;
      try { mtAction = Number(ev.getActionMasked()); } catch(eMtAction) {}
      if (mtAction === android.view.MotionEvent.ACTION_POINTER_DOWN) return true;
      if (mtAction === android.view.MotionEvent.ACTION_DOWN) {
        try {
          var mtDown = Number(ev.getDownTime());
          var mtEvent = Number(ev.getEventTime());
          if (!isNaN(mtDown) && !isNaN(mtEvent) && mtDown < mtEvent) return true;
        } catch(eMtTime) {}
        // V7.19 信号 4：指针 ID 非 0 = 这是进行中多指手势的后续手指
        // （split 到本窗的孤立 DOWN）。跨版本可靠，兜底信号 3 在
        // Android 13+ 的失效（split 事件 downTime 被重置为 eventTime）。
        try {
          var mtPid = Number(ev.getPointerId(0));
          if (!isNaN(mtPid) && mtPid !== 0) return true;
        } catch(eMtPid) {}
      }
      return false;
    };

    // ============================================================
    // V7.18：取字态全屏触摸监视窗（pickWatcher）
    // 背景：指针窗只有 60×84dp 且不带 FLAG_NOT_TOUCH_MODAL（带
    // FLAG_NOT_FOCUSABLE）——按输入分发规则它不是 touch-modal 窗口，
    // 只能收到落在自己可触区域（箭头+握点那 60×84dp）内的触摸，屏幕
    // 其余位置的触摸根本不会派发给它。V7.17 指望指针窗自己检测"窗外
    // 第二根手指"（ACTION_OUTSIDE / ACTION_POINTER_DOWN），两个信号
    // 都够不着，真机测试证实失败（详见 V7.18_优化说明.md 根因分析）。
    // 方案：复刻框选态捕获窗（真机已验证的模式）——在指针窗**之前**
    // addView 一个全屏可触控监视窗（同类型 overlay 后来者居上，监视窗
    // 位于指针窗下层）：箭头上的触摸仍归指针窗（拖动/跳转/取字流程
    // 完全不变），屏幕上其余位置的触摸落进监视窗。两个窗口共同覆盖
    // 整个屏幕，任何位置的第二根手指都有窗口可接。
    // ============================================================
    // V7.34：监视窗从 View 换成 FrameLayout —— 它同时是选择面板的**宿主**。
    // ViewGroup.addView 是进程内操作：不经过 binder、不建 Surface、不建
    // InputChannel、不进 WMS 窗口列表，也就不会牵动 a11y 的窗口树。
    // 面板全程不新建 overlay 窗口，是这套面板在真机上不崩的关键。
    app.createPickWatcherView = function() {
      var WatcherView = new android.widget.FrameLayout(context);
      try { WatcherView.setWillNotDraw(true); } catch(eWill) {}
      try { WatcherView.setClickable(true); } catch(e1) {}
      try { WatcherView.setFocusable(false); } catch(e2) {}
      return WatcherView;
    };

    app.showPickWatcher = function() {
      if (this.closed || !this.wm) return;
      if (this.pickWatcher) return;
      var watcher = this.createPickWatcherView();
      var lp = new android.view.WindowManager.LayoutParams(
        this.screenW, this.screenH,
        android.view.WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        android.view.WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE |
        android.view.WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN |
        android.view.WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        android.graphics.PixelFormat.TRANSLUCENT
      );
      lp.gravity = android.view.Gravity.TOP | android.view.Gravity.START;
      lp.x = 0;
      lp.y = 0;
      var self = this;
      watcher.setOnTouchListener(new JavaAdapter(android.view.View.OnTouchListener, {
        onTouch: function(v, ev) {
          // V7.34：面板开着时，触摸全交给面板的矩形命中判定。
          // 面板是位图，没有子 View 能接点击，所以"点到哪个词块/按钮"
          // 全部在这里按坐标算；落在卡片外一律当取消。
          try {
            if (self.selectPanelInfo) {
              try { self.handleSelectPanelTouch(ev); } catch(eHpt) {}
              return true;
            }
          } catch(ePc2) {}
          try {
            if (!self.areaModeActive && !self.closed && self.checkMultiTouchExit(ev)) {
              try { self.exitByMultiTouch(); } catch(eMultiExit) {}
              return true;
            }
          } catch(eMt) {}
          // 取字态下不在箭头上的触摸由本窗统一消费（与框选态捕获窗一致：
          // 取字/框选期间不与应用交互）；框选态下本窗位于捕获窗下层，
          // 本来就收不到新事件，到这里直接消费即可。
          return true;
        }
      }));
      try {
        this.wm.addView(watcher, lp);
        this.pickWatcher = watcher;
        this.pickWatcherLp = lp;   // V7.33.5：留引用，指标变化时改宽高重挂
      } catch(eAdd) {
        // 添加失败不影响指针本身（窗外多指检测退化为仅箭头窗内信号）
        this.pickWatcher = null;
        this.pickWatcherLp = null;
      }
    };

    app.removePickWatcher = function() {
      var old = this.pickWatcher;
      this.pickWatcher = null;
      this.pickWatcherLp = null;   // V7.33.5
      try { if (old) old.setOnTouchListener(null); } catch(e0) {}
      try { if (old && this.wm) this.wm.removeViewImmediate(old); } catch(e1) {
        try { if (old && this.wm) this.wm.removeView(old); } catch(e2) {}
      }
    };

    // 第二根手指点击：取消框选，回到指针取字态
    app.cancelAreaModeBySecondFinger = function() {
      if (this.closed || !this.areaModeActive) return;
      this.returnToTextPickFromArea();
    };

    // ============================================================
    // V7.17：取字态多指退出（取字态版的退出出口，与上面框选态的
    // cancelAreaModeBySecondFinger 对应：那边第二根手指返回取字态，
    // 这边第二根手指直接完全退出）
    // 收尾与"点击未取到字取消"完全一致：close() 拆除全部悬浮窗、
    // 停后台查询线程、清 Handler 回调；finishCancel 正常收尾，
    // 由指令链 SwitchCase 的取消分支接管（Toast 反馈同取消路径）。
    // ============================================================
    app.exitByMultiTouch = function() {
      if (this.closed) return;
      try { this.close(); } catch(eClose) {}
      finishCancel("多指退出");
    };

    app.resetAreaState = function() {
      this.areaModeActive = false;
      this.areaHoldToken++;
      this.areaHoldAnchorX = -99999;
      this.areaHoldAnchorY = -99999;
      this.areaStartX = -1;
      this.areaStartY = -1;
      this.areaEndX = -1;
      this.areaEndY = -1;
      this.areaFrozenVisualRect = null;
      this.areaFrozenCaptureRect = null;
      this.areaCapturing = false;
      this.areaCaptureRunnable = null;
      this.areaDrawnRect = null;   // V7.77：脏区基准跟着状态一起复位
      try { if (this.pointer) this.pointer.invalidate(); } catch(e0) {}
    };

    // 截图保存目录：ShortX 私有目录 data/screenshots。
    // V7.11.2 起这是唯一路径——V7.10/V7.11 的「系统截图目录」保存链
    // （公共目录直写 / shell cp 复制 / MediaStore 相册复制）实测在该机型上
    // 始终不生效，截图最终仍落在私有目录，已整条移除。
    app.getShortXScreenshotDir = function() {
      var base = "";
      try {
        if (typeof shortx !== "undefined" && shortx && shortx.getShortXDir) {
          base = String(shortx.getShortXDir());
        }
      } catch(e0) {}
      if (!base) throw new Error("无法获取 ShortX 私有目录");
      var dir = new java.io.File(base + "/data/screenshots");
      if (!dir.exists()) dir.mkdirs();
      return dir;
    };

    app.createScreenshotFile = function() {
      var d = new Date();
      function z(n) { return n < 10 ? "0" + n : String(n); }
      var ymd = String(d.getFullYear()) + z(d.getMonth() + 1) + z(d.getDate());
      var ts = String(d.getTime());
      return new java.io.File(this.getShortXScreenshotDir(), "Shortx_" + ymd + "_" + ts + ".png");
    };

    app.saveBitmapToFile = function(bitmap, file) {
      if (!bitmap || !file) throw new Error("Bitmap 或文件对象为空");
      try { file.getParentFile().mkdirs(); } catch(e0) {}
      // V7.54：加 64KB 缓冲。PNG 编码器是分块往下写的，1.5K 屏一张图
      // 会产生几百次 write syscall，缓冲后只剩二三十次（省 10~40ms，
      // 而且这段正在「松手到看得见」的关键路径上）。
      var out = new java.io.BufferedOutputStream(new java.io.FileOutputStream(file), 65536);
      var encOk = false;
      try {
        bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out);
        out.flush();
        encOk = true;
      } finally {
        try { out.close(); } catch(e1) {}
        // V7.31：编码失败删除半成品文件——不留
        // 0 字节/损坏残file 在 ShortX 私有目录（异常继续向上传播，
        // 由调用方的 CAPTURE_FAILED 链路处理）
        if (!encOk) { try { file.delete(); } catch(eEncDel) {} }
      }
    };

    // V7.55：wantThumb=true 时顺手做一张缩略图（面板里显示的那张）。
    // 在**截图线程**里做，返回时已经缩好 —— 面板主线程只 drawBitmap，
    // 不再解码/缩放，关键路径上不会多出 50~150ms。
    app.captureAreaToFile = function(rect, presetFile, wantThumb) {
      if (!rect || rect.width < this.areaMinSize || rect.height < this.areaMinSize) {
        throw new Error("框选区域太小");
      }
      // V7.13：阶段诊断标记（失败时随 data.stage 返回）
      this.captureStage = "screenshot";
      var tShot = nowMs();
      var cropRect = new android.graphics.Rect(rect.left, rect.top, rect.right, rect.bottom);
      var file = presetFile || this.createScreenshotFile();
      var api = 0;
      try { api = android.os.Build.VERSION.SDK_INT; } catch(eApi) { api = 0; }
      var cw = rect.width;
      var chh = rect.height;
      var bitmap = null;
      var lastError = null;
      function bitmapFromHardwareBuffer(buffer) {
        if (!buffer) return null;
        try {
          var b = buffer.asBitmap();
          if (b) return b;
        } catch(e0) {}
        try {
          var hb = buffer.getHardwareBuffer ? buffer.getHardwareBuffer() : null;
          if (hb) return android.graphics.Bitmap.wrapHardwareBuffer(hb, android.graphics.ColorSpace.get(android.graphics.ColorSpace.Named.SRGB));
        } catch(e1) {}
        return null;
      }
      // ===== V7.77：四条捕获通路做成表，**上次成功的那条排到最前** =====
      // 旧写法是一条 if 链，每张图都从 api>=34 的 parcel 交易起步。Android 13
      // 上那条被 `api < 34` 直接跳过（不花钱），但在 14/15 上若它一路失败，
      // 每张截图都要先构造十几个 Rhino 异常（解释器里异常很贵），再落到
      // 真正能用的那条 —— 用户体感就是「按下去要顿一下」。
      var tries = [
        // ① Android 14+：DisplayCaptureArgs（AIDL SurfaceFlinger）
        function() {
          if (api < 34) return null;
          var surfaceFlingerService = android.os.ServiceManager.getService("SurfaceFlingerAIDL");
          var displayInfo = android.hardware.display.DisplayManagerGlobal.getInstance().getDisplayInfo(0);
          var displayId = displayInfo.address.getPhysicalDisplayId();
          var parcelData = android.os.Parcel.obtain();
          var parcelReply = android.os.Parcel.obtain();
          parcelData.writeInterfaceToken("android.gui.ISurfaceComposer");
          parcelData.writeLong(displayId);
          surfaceFlingerService.transact(android.os.IBinder.FIRST_CALL_TRANSACTION + 6, parcelData, parcelReply, 0);
          parcelReply.readException();
          var displayToken = parcelReply.readStrongBinder();
          parcelData.recycle();
          parcelReply.recycle();
          try {
            var builder = new android.window.ScreenCapture.DisplayCaptureArgs.Builder(displayToken);
            builder.setPixelFormat(android.graphics.PixelFormat.RGBA_8888)
                   .setSourceCrop(cropRect)
                   .setSize(cw, chh)
                   .setFrameScale(1.0)
                   .setCaptureSecureLayers(true)
                   .setAllowProtected(true)
                   .setGrayscale(false)
                   .setExcludeLayers(null)
                   .setHintForSeamlessTransition(false);
            return bitmapFromHardwareBuffer(android.window.ScreenCapture.captureDisplay(builder.build()));
          } catch(e14old) {
            var builder2 = new android.window.ScreenCaptureInternal.DisplayCaptureArgs.Builder(displayToken);
            builder2.setPixelFormat(android.graphics.PixelFormat.RGBA_8888)
                    .setSourceCrop(cropRect)
                    .setSize(cw, chh)
                    .setFrameScale(1.0)
                    .setSecureContentPolicy(0)
                    .setProtectedContentPolicy(0)
                    .setGrayscale(false)
                    .setExcludeLayers(null);
            return bitmapFromHardwareBuffer(android.window.ScreenCaptureInternal.captureDisplay(builder2.build()));
          }
        },
        // ② Android 12+：SurfaceControl.captureDisplay
        function() {
          if (api < 32) return null;
          var displayToken32 = android.view.SurfaceControl.getInternalDisplayToken();
          if (displayToken32 == null) throw new Error("无法获取 displayToken");
          var builder32 = new android.view.SurfaceControl.DisplayCaptureArgs.Builder(displayToken32);
          builder32.setPixelFormat(android.graphics.PixelFormat.RGBA_8888)
                   .setSourceCrop(cropRect)
                   .setSize(cw, chh)
                   .setFrameScale(1.0)
                   .setCaptureSecureLayers(true)
                   .setAllowProtected(true)
                   .setGrayscale(false);
          return bitmapFromHardwareBuffer(android.view.SurfaceControl.captureDisplay(builder32.build()));
        },
        // ③ Android 10+：screenshotToBufferWithSecureLayersUnsafe
        function() {
          if (api < 29) return null;
          var displayToken29 = android.view.SurfaceControl.getInternalDisplayToken();
          if (displayToken29 == null) throw new Error("无法获取 displayToken");
          var sgBuffer = android.view.SurfaceControl.screenshotToBufferWithSecureLayersUnsafe(
            displayToken29, cropRect, cw, chh, false, 0
          );
          if (!sgBuffer) return null;
          return android.graphics.Bitmap.wrapHardwareBuffer(
            sgBuffer.getGraphicBuffer(),
            android.graphics.ColorSpace.get(android.graphics.ColorSpace.Named.SRGB)
          );
        },
        // ④ 最老的 screenshotToBuffer
        function() {
          var sgBufferOld = android.view.SurfaceControl.screenshotToBuffer(
            cropRect, cw, chh, 0, java.lang.Integer.MAX_VALUE, false, 0
          );
          if (!sgBufferOld) return null;
          return android.graphics.Bitmap.wrapHardwareBuffer(
            sgBufferOld.getGraphicBuffer(),
            android.graphics.ColorSpace.get(android.graphics.ColorSpace.Named.SRGB)
          );
        }
      ];
      var startIdx = Number(this.captureMethod);
      if (!(startIdx >= 0 && startIdx < tries.length)) startIdx = 0;
      for (var step = 0; step < tries.length && !bitmap; step++) {
        var idx = (startIdx + step) % tries.length;
        try {
          bitmap = tries[idx]();
          if (bitmap) this.captureMethod = idx;
        } catch(eTry) { lastError = eTry; bitmap = null; }
      }
      if (!bitmap) {
        throw new Error("截图失败" + (lastError ? ": " + String(lastError) : ""));
      }
      probeLog("AREA_T_SHOT ms=" + (nowMs() - tShot) + " m=" + this.captureMethod);
      this.captureStage = "save";
      // V7.54：PNG 编码这一段是纯 CPU 阻塞，1.5K 屏常要 100~250ms；
      // 单独量出来，好判断该不该把它挪出关键路径。
      var tEnc = nowMs();
      // ===== V7.77：HARDWARE 位图只 readback 一次 =====
      // 捕获回来的是 HARDWARE（GPU 显存）位图。旧流程里它被读两遍：
      //   compress() 内部要 readback 才能编码；
      //   buildAreaThumb() 里往软件 Canvas 上 drawBitmap 会抛
      //   "Software rendering doesn't support hardware bitmaps"，catch 里
      //   再 copy 一次 ARGB_8888。
      // 现在先 copy 一次，编码与缩略图共用这张软件位图 —— 少了整幅的一次
      // GPU→CPU 读回。copy 失败（老 API / 内存紧张）就原路返回，行为不变。
      var soft = null;
      try {
        var cfg = null;
        try { cfg = String(bitmap.getConfig()); } catch(eCfg) {}
        var px = Number(bitmap.getWidth()) * Number(bitmap.getHeight());
        if (cfg === "HARDWARE" && px > 0 && px <= 6000000) {
          soft = bitmap.copy(android.graphics.Bitmap.Config.ARGB_8888, false);
        }
      } catch(eCopy) { soft = null; }
      var src = soft || bitmap;
      try {
        this.saveBitmapToFile(src, file);
        probeLog("AREA_T_ENC ms=" + (nowMs() - tEnc));
        // V7.11.2：只保存 ShortX 私有目录（系统截图目录链实测不生效已移除）；
        // OCR 契约读同一文件，返回 JSON 协议不变
        if (wantThumb) this.buildAreaThumb(src);
      } finally {
        if (soft) { try { soft.recycle(); } catch(eRs) {} }
      }
      return String(file.getAbsolutePath());
    };

    // V7.55：截图缩略图。面板里显示的那张，最多 480px 高。
    // 为什么不留原图：1.5K 屏的原图是 8.9MB，面板本身双缓冲已经占 ~18MB，
    // 再挂一张原图很容易把 system_server 推到 OOM —— 那可不是闪退，是软重启。
    // V7.56：**必须是软件位图**。截图 API（ScreenCapture / wrapHardwareBuffer）
    // 拿到的是 HARDWARE 配置，createScaledBitmap 缩出来的目标**仍是 HARDWARE**；
    // HARDWARE 位图往软件 Canvas 上 drawBitmap 会抛 "Software rendering doesn't
    // support hardware bitmaps"，旧版两处 catch 各吞一次异常，面板上就是一块
    // 空白 —— 用户看到的就是"透明缩略图"。这里自己建 ARGB_8888 再画进去。
    app.buildAreaThumb = function(bitmap) {
      try { if (this.areaThumb && !this.areaThumb.isRecycled()) this.areaThumb.recycle(); } catch(eTh0) {}
      this.areaThumb = null;
      if (!bitmap) return;
      try {
        var w0 = Number(bitmap.getWidth());
        var h0 = Number(bitmap.getHeight());
        if (!(w0 > 0) || !(h0 > 0)) return;
        var maxPx = 480;
        var nh = (h0 > maxPx) ? maxPx : h0;
        var nw = Math.round(w0 * nh / h0);
        if (!(nw > 0)) nw = 1;
        var tp2 = new android.graphics.Paint();
        tp2.setAntiAlias(true);
        try { tp2.setFilterBitmap(true); } catch(eFb) {}
        try { tp2.setDither(true); } catch(eDt) {}
        var dst2 = new android.graphics.Rect(0, 0, nw, nh);
        function drawInto(src) {
          var b = android.graphics.Bitmap.createBitmap(nw, nh,
            android.graphics.Bitmap.Config.ARGB_8888);
          new android.graphics.Canvas(b).drawBitmap(src, null, dst2, tp2);
          return b;
        }
        var out = null;
        try {
          out = drawInto(bitmap);
        } catch(eSoft) {
          // HARDWARE 源：先 copy 成 ARGB_8888（API 26+ 支持），再画。
          var soft = null;
          try { soft = bitmap.copy(android.graphics.Bitmap.Config.ARGB_8888, false); } catch(eCp) { soft = null; }
          if (!soft) throw eSoft;
          try { out = drawInto(soft); } finally { try { soft.recycle(); } catch(eSr) {} }
        }
        if (out && Number(out.getWidth()) > 0 && Number(out.getHeight()) > 0) {
          this.areaThumb = out;
        } else {
          try { if (out) out.recycle(); } catch(eOr) {}
          probeLog("AREA_THUMB_EMPTY");
        }
      } catch(eTh1) {
        this.areaThumb = null;
        try { probeLog("AREA_THUMB_FAIL " + String(eTh1 && eTh1.message ? eTh1.message : eTh1)); } catch(eTh2) {}
      }
    };

    app.finishAreaCapture = function() {
      // V7.54：松手瞬间的时钟基准。后面 AREA_T_READY / AREA_T_TOTAL
      // 都以它为 0 点，量的是用户真正看到的那段等待。
      var tLift = nowMs();
      this.areaT0 = tLift;
      var visualRect = this.getAreaVisualRect();
      this.areaFrozenVisualRect = {
        left: visualRect.left,
        top: visualRect.top,
        right: visualRect.right,
        bottom: visualRect.bottom,
        width: visualRect.width,
        height: visualRect.height
      };
      var captureRect = this.getAreaCaptureRect();
      this.areaFrozenCaptureRect = {
        left: captureRect.left,
        top: captureRect.top,
        right: captureRect.right,
        bottom: captureRect.bottom,
        width: captureRect.width,
        height: captureRect.height
      };
      if (this.areaFrozenCaptureRect.width < this.areaMinSize || this.areaFrozenCaptureRect.height < this.areaMinSize) {
        try { this.close(); } catch(eSmallClose) {}
        finishError("area_capture", "AREA_TOO_SMALL", "框选区域太小");
        return false;
      }
      this.areaCapturing = true;
      // V7.66：松手这一刻没有吐司。**不是漏了** —— 吐司由 ShortX 指令链里
      // 的「显示吐司」动作负责，而那条链要等脚本交付结果之后才会跑；松手
      // 这一瞬脚本还在自己肚子里（截图 + 编码 + OCR），没有任何动作能插进来。
      // 这里给反馈的是 panelNotice（"正在识别截图里的文字…（点屏幕跳过）"），
      // 它画在悬浮层上，同样能告诉用户"按到了、在跑"。
      // V7.33.7：截图前隐藏框选框——2dp 描边会被
      // ScreenCapture 一起截进去，旧实现只能靠 3dp 内缩裁掉（视觉贴边、
      // 图却少一条）。隐藏后内缩降到 1dp（仅防一帧残影）。
      try { if (this.areaFrame) this.areaFrame.setVisibility(android.view.View.INVISIBLE); } catch(eHideAreaFrame) {}
      if (this.areaIdleRunnable && this.handler) {
        try { this.handler.removeCallbacks(this.areaIdleRunnable); } catch(e) {}
      }
      this.areaIdleRunnable = null;
      try { if (this.areaFrame) this.areaFrame.invalidate(); } catch(eAreaInv) {}
      try { this.hideFrame(); } catch(eHideTextFrame) {}
      try { this.hideTextPanel(); } catch(eHideTextPanel) {}
      try {
        if (this.pointer) {
          this.pointer.setVisibility(android.view.View.INVISIBLE);
          this.pointer.setAlpha(0);
          this.pointer.invalidate();
        }
      } catch(eHidePointer) {}
      // V7.0：截图文件在主线程预创建（ ShortX 目录获取保持在主线程），
      // 截图编码与保存放到后台线程执行，主线程不再等待 PNG 编码。
      var capFile = null;
      try { capFile = this.createScreenshotFile(); } catch(eFile) {
        this.resetAreaState();
        try { this.close(); } catch(eCloseFile) {}
        finishError("area_capture", "CAPTURE_FAILED", "截图失败: " + String(eFile.message || eFile), { stage: "create_file" });
        return false;
      }
      var self = this;
      this.areaCaptureRunnable = new java.lang.Runnable({ run: function() {
        var path = null;
        var err = null;
        try { path = self.captureAreaToFile(self.areaFrozenCaptureRect, capFile, true); } catch(eCap) { err = eCap; }
        var h = self.handler;
        if (!h) return;
        h.post(new java.lang.Runnable({ run: function() {
          try { self.removeAreaFrameNow(); } catch(eRm) {}
          if (err) {
            try { self.close(); } catch(eC1) {}
            finishError("area_capture", "CAPTURE_FAILED", "截图失败: " + String(err.message || err),
              { stage: self.captureStage || "capture" });
            return;
          }
          try {
            // V7.35：交付信息先存下来。截图之后可能还要「OCR → 选字面板」
            // 才交付，那段时间不能 close（面板挂在监视窗上），所以得先记住
            // 这张图是什么；真正交付统一走 finishAreaResult。
            self.areaResult = {
              path: String(path),
              visualRect: rectObjToJson(self.areaFrozenVisualRect),
              captureRect: rectObjToJson(self.areaFrozenCaptureRect)
            };
            // 有 OCR 类 + 开关打开才走识别；任何一步不成立都退回原行为。
            // 单独 try：这里抛异常绝不能变成「截图失败」—— 图已经在盘上了。
            var ocrTaken = false;
            try {
              ocrTaken = (self.areaOcrPanel === true && self.beginAreaOcrPanel());
            } catch(eAop) {
              probeLog("AREA_OCR_THROW " + String(eAop && eAop.message ? eAop.message : eAop));
              ocrTaken = false;
            }
            if (ocrTaken) return;
            self.finishAreaResult("", { keep: true });
          } catch(eFin) {
            try { self.close(); } catch(eC3) {}
            finishError("area_capture", "CAPTURE_FAILED", "截图失败: " + String(eFin.message || eFin),
              { stage: "finalize" });
          }
        }}));
      }});
      var target = (this.bgEnabled && this.bgHandler) ? this.bgHandler : this.handler;
      try { target.postDelayed(this.areaCaptureRunnable, this.areaCaptureDelay); } catch(ePost) {
        try {
          if (this.pointer && !this.closed) {
            this.pointer.setAlpha(1);
            this.pointer.setVisibility(android.view.View.VISIBLE);
            this.pointer.invalidate();
          }
        } catch(eShow2) {}
        this.resetAreaState();
        try { this.close(); } catch(eClose3) {}
        finishError("area_capture", "CAPTURE_TASK_FAILED", "截图任务启动失败: " + String(ePost.message || ePost));
      }
      return true;
    };

    // ===== V7.66：落盘只留一条路 —— 交给导入侧 shell =====
    // V7.61~65 在脚本里做过两套落盘（provider pending 流程、java.io 直写 +
    // 请系统扫描 + 轮询 + 备胎），导入侧的 shell 里还有第三套（mv + 扫库 +
    // 查 _id）。同一件事三种实现，互相覆盖、互相抢 MediaProvider，延时就
    // 忽长忽短 —— 这正是用户说的"方式太多反而冲突"。
    // 现在只留一条：脚本把临时 png 留在 ShortX 私有目录，导入侧 shell 负责
    // 搬进 DCIM/Screenshots、刷图库、需要时 am start。脚本这边零文件写入、
    // 零 binder 调用，分享链路上再没有"可能卡住"的环节。
    // V7.74：这里原来的 .share_uri 交接口（脚本写一行文件名给 shell 读）已删。
    // V7.72 起 shell 是 ls -t 自己取最新一张，没人读它 —— 纯死代码。


    // ===== V7.35：框选截图的交付 =====
    // pickedText 非空时附带在 data 里，导入侧「截图/ocr」分支优先用它，
    // 不再对全图跑一遍 OCR —— 用户挑的字就是结果。
    // V7.36：flags = { canceled: true } 表示「用户主动点了取消」。
    // 两条路（取字/截图）统一口径：取消就是取消，不产生任何文字结果；
    // 图本身仍然交付（截图模式的价值就是那张图），所以不能走 finishCancel。
    app.finishAreaResult = function(pickedText, flags) {
      // V7.61：分段计时的起点。用户点按钮 → 这里被调用，中间没有别的环节。
      var tEnter = nowMs();
      var info = this.areaResult;
      this.areaResult = null;
      this.areaOcrRunning = false;
      try { if (this.areaOcrTimer && this.handler) this.handler.removeCallbacks(this.areaOcrTimer); } catch(eAt0) {}
      this.areaOcrTimer = null;
      if (!info) {
        // 正常路径不会到这里；真到了（并发清理）也必须收尾 —— 否则 latch
        // 不释放，指令链会挂到 300s 看门狗。V7.74 删了错误分支后这条路径
        // 不再有任何提示，用户看到的就是"指针消失了"。
        try { this.close(); } catch(eAt1) {}
        finishError("area_capture", "CAPTURE_LOST", "截图结果已丢失");
        return false;
      }
      // V7.74：只留导入侧真正读的字段（visualRect / captureRect 给
      // 「截图/选字」算 OCR 矩形）。name / mime / sizeBytes 从来没人读，删。
      var data = {
        visualRect: info.visualRect,
        captureRect: info.captureRect
      };
      // V7.56：**用户没按保存/分享就不落盘**。但要区分两种"没有 action"：
      //   ① 面板弹出来了，用户点了复制 / 取消 / 面板外 —— 明确不要图，删；
      //   ② 面板根本没弹出来（OCR 不可用 / 超时 / 无字 / 建面板失败）——
      //      用户连按钮都没见过，删图等于"框了半天什么都没拿到"，保留。
      //      这类调用点显式传 flags.keep === true。
      var act0 = (flags && flags.action) ? String(flags.action) : "";
      var keepFile = !!(flags && (flags.action === "save" || flags.action === "share" ||
                                  flags.keep === true));
      // V7.66：脚本**不再写文件**。落盘、刷图库、分享全在导入侧 shell 里，
      // 这样"图怎么进相册"只有一条路 —— 不会出现脚本写一份、shell 又搬一份
      // 的重复与竞争。save / share 都保留临时 png（keepFile 见上）。
      if (!keepFile) {
        try {
          var fDel = new java.io.File(String(info.path));
          if (fDel.exists()) fDel.delete();
        } catch(eDel) {}
      }
      var pt = String(pickedText || "");
      if (pt.length > 0) data.pickedText = pt;
      // V7.36：只有「用户点了取消」才打这个标；超时/无字/面板失败属于
      // 被动降级，不带 cancel，导入侧两者都按「无字」处理（只存图）。
      if (flags && flags.canceled === true) data.cancel = true;
      // V7.55：面板上点了「保存图片 / 分享」。导入侧按这个字段分流：
      // save → 只存图；share → 存图后拉起系统分享面板。
      if (flags && flags.action) data.areaAction = String(flags.action);
      // 先把面板关掉，再让分享框起来 —— 反过来的话两个窗口会叠在一起，
      // 分享框背后还露着选字面板。
      try { this.close(); } catch(eAt2) {}
      // V7.74：分享这边不再写任何文件。落盘、刷库、am start 全在导入侧的
      // 三条短命令里，脚本只负责把 areaAction=share 交给 SwitchCase。
      if (act0 === "share") probeLog("SHARE_T_CLOSE d=" + (nowMs() - tEnter));
      // V7.77：松手 → 交付的总时长（areaT0 是松手那一刻）。这一条是用户
      // 真正感知的那段：等待 + 截图 + 编码 +（有面板时）OCR + 用户挑选。
      // 不带 areaT0（不是截图链路）就不打，免得日志里出现负值。
      if (this.areaT0 > 0) {
        probeLog("AREA_T_TOTAL d=" + (nowMs() - this.areaT0) +
                 " act=" + (data.areaAction ? data.areaAction : "-"));
      }
      var result = makeResult(true, "area_capture", "AREA_CAPTURE_SUCCESS", "框选截图成功", String(info.path), data);
      probeLog("SHARE_T_DONE d=" + (nowMs() - tEnter));
      probeLog("AREA_DELIVER len=" + pt.length + " cancel=" + (data.cancel === true ? 1 : 0) +
               " keep=" + (keepFile ? 1 : 0) +
               " share=" + (act0 === "share" ? 1 : 0) +
               (data.areaAction ? (" action=" + data.areaAction) : ""));
      // V7.70：这里必须 flush。probeLog 是 12 条一组的缓冲，而脚本返回之后
      // 就没人再调它了 —— V7.69 的日志停在 SHARE_T_HANDOFF，害我以为脚本
      // 崩在 makeResult，其实是这两行被缓冲吞了。
      try { probeFlush(); } catch(ePF2) {}
      finishWithJson(result);
      return true;
    };

    // ===== V7.35：截图 → OCR → 选字面板 =====
    // 返回 true 表示「接管了这次交付」：调用方不要再自行 finishWithJson。
    // 返回 false 表示条件不满足，调用方按旧路径立即交付截图。
    app.beginAreaOcrPanel = function() {
      var self = this;
      // V7.53：这两个出口原来是静默的 —— 日志里既没有 BEGIN 也没有 SKIP，
      // 出了「截图后不弹面板」根本没法判断卡在哪。补上探针。
      if (this.closed) { probeLog("AREA_OCR_SKIP session_closed"); return false; }
      if (!this.areaResult) { probeLog("AREA_OCR_SKIP no_area_result"); return false; }
      // 开关关了就完全不做识别（内部再判一次，防止被别处直接调用）。
      if (this.areaOcrPanel !== true) { probeLog("AREA_OCR_SKIP switch_off"); return false; }
      // 面板被自愈守卫关过 / 上次建面板失败过：这次不要再折腾，直接出图。
      if (this.selectPanel !== true) { probeLog("AREA_OCR_SKIP panel_off"); return false; }
      if (this.selectPanelFailed === true) { probeLog("AREA_OCR_SKIP panel_failed"); return false; }
      if (!HAS_OCR_DETECT || !HAS_OCR_RECTSRC || !HAS_OCR_ANY) {
        probeLog("AREA_OCR_SKIP no_class");
        return false;
      }
      var path = String(this.areaResult.path || "");
      if (!path) { probeLog("AREA_OCR_SKIP no_path"); return false; }

      this.areaOcrRunning = true;
      probeLog("AREA_OCR_BEGIN");
      // V7.54：松手 → OCR 真正开跑，这一段里含固定等待 + 截图 + PNG 编码。
      var tReady = nowMs();
      if (this.areaT0 > 0) probeLog("AREA_T_READY d=" + (tReady - this.areaT0));
      // 识别要 1~3s，先告诉用户为什么还没出结果；点屏幕可跳过。
      panelNotice("正在识别截图里的文字…（点屏幕跳过）");

      try {
        this.areaOcrTimer = new java.lang.Runnable({ run: function() {
          if (!self.areaOcrRunning) return;
          probeLog("AREA_OCR_TIMEOUT");
          self.areaOcrRunning = false;
          self.areaOcrTimer = null;
          try { self.finishAreaResult("", { keep: true }); } catch(eTo) {}
        }});
        this.handler.postDelayed(this.areaOcrTimer, Number(this.areaOcrTimeout) || 8000);
      } catch(eTimer) {}

      var thread = new java.lang.Thread(new java.lang.Runnable({ run: function() {
        var text = "";
        var errText = "";
        var tOcr = nowMs();
        try {
          // 与 runOcrFallback 同一条链路：文件源（RectSourcePath）→ JSON。
          // 这里**不删**这张图 —— 它是本次要交付给用户的截图。
          var act = OcrDetect.newBuilder()
            .setRectSrc(Any.pack(RectSourcePath.newBuilder().setPath(String(path)).build()))
            .setThreads(4)
            .setUseSlim(false)
            .setSeparator("\n")
            .build();
          var res = shortx.executeAction(act);
          var jsonText = "";
          try { jsonText = String(res.contextData.get("ocrResult") || ""); } catch(eGet) {}
          text = self.ocrTextOf(jsonText);
        } catch(eOcr) {
          errText = String(eOcr && eOcr.message ? eOcr.message : eOcr);
        }
        // V7.54：OCR 本体（含 executeAction 里的解码+识别）单独计时。
        probeLog("AREA_T_OCR ms=" + (nowMs() - tOcr));
        var h = self.handler;
        if (!h) { self.areaOcrRunning = false; return; }
        h.post(new java.lang.Runnable({ run: function() {
          // 已被跳过/超时/会话关闭：这次结果直接丢掉
          if (!self.areaOcrRunning) return;
          self.areaOcrRunning = false;
          try { if (self.areaOcrTimer) self.handler.removeCallbacks(self.areaOcrTimer); } catch(eCt) {}
          self.areaOcrTimer = null;
          if (errText) probeLog("AREA_OCR_FAIL " + errText);
          var t = "";
          try { t = trimText(String(text || "")); } catch(eTrim) { t = String(text || ""); }
          self.areaOcrDoneAt = nowMs();
          // V7.54：d = 松手到 OCR 出结果的总时长，一眼对上用户体感。
          probeLog("AREA_OCR_DONE len=" + t.length +
                   (self.areaT0 > 0 ? (" d=" + (self.areaOcrDoneAt - self.areaT0)) : ""));
          var pMin = Number(self.areaOcrMinChars);
          if (!(pMin >= 1)) pMin = 1;
          var pMax = Number(self.areaOcrMaxChars);
          if (!(pMax > 0)) pMax = 2000;
          if (t.length < pMin || t.length > pMax) {
            probeLog("AREA_OCR_NOPANEL len=" + t.length + " min=" + pMin + " max=" + pMax);
            try { self.finishAreaResult("", { keep: true }); } catch(eF0) {}
            return;
          }
          self.panelKind = "area";
          self.selectPanelDone = false;
          var delay = Number(self.areaOcrPanelDelay);
          if (!(delay >= 0)) delay = 0;
          probeLog("AREA_PANEL_POST delay=" + delay);
          try {
            self.handler.postDelayed(new java.lang.Runnable({ run: function() {
              if (self.closed || !self.areaResult) return;
              if (self.showSelectPanel(t)) return;
              // 面板建不起来：原因已经由 showSelectPanel 的 fail() 说过，
              // 这里只把图交出去，不再重复提示。
              probeLog("AREA_PANEL_FAIL");
              self.panelKind = "text";
              self.selectPanelFailed = true;
              try { self.finishAreaResult("", { keep: true }); } catch(eF1) {}
            }}), delay);
          } catch(ePost) {
            self.panelKind = "text";
            try { self.finishAreaResult("", { keep: true }); } catch(eF2) {}
          }
        }}));
      }}));
      try { thread.setDaemon(true); } catch(eDm) {}
      try {
        thread.start();
      } catch(eStart) {
        this.areaOcrRunning = false;
        probeLog("AREA_OCR_SKIP thread_start_fail");
        return false;
      }
      return true;
    };

    // OCR JSON → 整段文字（块之间按上下、左右排序后换行拼接）。
    // 与 parseOcrBlocks 的分块口径一致：直接用块级 text，注意块内已经
    // 按阅读序拼好，这里只负责块间顺序。
    app.ocrTextOf = function(jsonText) {
      var blocks = [];
      try { blocks = this.parseOcrBlocks(String(jsonText || "")); } catch(e0) { blocks = []; }
      if (!blocks || blocks.length === 0) return "";
      var arr = blocks.slice();
      arr.sort(function(a, b) {
        var d = Number(a.top || 0) - Number(b.top || 0);
        if (Math.abs(d) > 2) return d;
        return Number(a.left || 0) - Number(b.left || 0);
      });
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        var t = String(arr[i].text || "");
        if (t.length > 0) out.push(t);
      }
      return out.join("\n");
    };

    // ===== V7.44：弹框即终点 =====
    // 面板一弹出来，本次会话就只剩「用户挑字 → 复制 / 取消」这一件事，
    // 之后的自动动作一律停手。最典型的是预热 OCR 完成时补弹「识别已就绪」：
    // 这句话本来是「后台暖机好了，你可以开始取字」的意思，可它跑在后台
    // 2~4s，完成时用户往往已经松手弹框了 —— 卡片上再冒一句「识别已就绪」
    // 纯属噪音，还挡字。
    // 四个信号任一成立即算到终点（前两个走取字路径，后两个走截图路径）：
    //   selectPanelInfo  面板真的挂上去了；
    //   selectPanelDone  deliverText 已占位、面板 260ms 后落地（覆盖空档）；
    //   areaResult       截图已落盘，接下来只剩 OCR→弹框 或者 直接交付；
    //   areaOcrRunning   截图 OCR 正在跑（areaResult 其实已置位，双保险）。
    // 判据只读状态、不改状态，任何地方调用都安全。
    app.panelReached = function() {
      if (this.selectPanelInfo) return true;
      if (this.selectPanelDone === true) return true;
      if (this.areaResult) return true;
      if (this.areaOcrRunning === true) return true;
      return false;
    };

    app.finishTextPick = function(picked) {
      var hp = this.hotspot();
      var rect = this.currentTextRect;
      return this.deliverText(String(picked || ""), hp, rect);
    };

    // ===== V7.34：取字结果交付 =====
    // 两条路：① 弹「选择文字」面板（默认）；② 直接回传整段文字。
    app.deliverText = function(text, hp, rect) {
      var s = String(text || "");
      probeLog("DELIVER len=" + s.length + " panel=" + (this.selectPanel ? 1 : 0) +
               " done=" + (this.selectPanelDone ? 1 : 0) + " failed=" + (this.selectPanelFailed ? 1 : 0));
      if (hp === undefined || hp === null) { try { hp = this.hotspot(); } catch(eHp) { hp = { x: 0, y: 0 }; } }
      if (rect === undefined) rect = this.currentTextRect;
      // "为什么不弹面板"要逐条讲清楚：旧写法是一个四条件联判，任意一条
      // 不满足就静默直接复制，用户只看到"没弹框"，日志也只有一个 DIRECT。
      var pMin = Number(this.selectPanelMinChars) || 1;
      var pMax = Number(this.selectPanelMaxChars);
      if (!(pMax > 0)) pMax = 2000;
      var skipWhy = "";
      if (this.selectPanel !== true) skipWhy = "面板已关闭";
      else if (this.selectPanelDone === true) skipWhy = "面板已打开";
      else if (this.selectPanelFailed === true) skipWhy = "面板上次失败";
      else if (s.length < pMin) skipWhy = "文本过短(" + s.length + "字)";
      else if (s.length > pMax) skipWhy = "文本过长(" + s.length + ">" + pMax + "字)";
      var opened = false;
      if (skipWhy === "") {
        var self = this;
        this.panelKind = "text";     // V7.35：确认/取消要按用途分流
        this.pendingPick = { text: s, hp: { x: hp.x, y: hp.y }, rect: rect };
        this.selectPanelDone = true;                 // 先占位，防重入触发两次
        try { if (this.pointer) this.pointer.setAlpha(0); } catch(eA0) {}
        var delay = Number(this.selectPanelDelay);
        if (!(delay >= 0)) delay = 260;
        probeLog("PANEL_POST delay=" + delay);
        try {
          this.handler.postDelayed(new java.lang.Runnable({ run: function() {
            probeLog("PANEL_RUN closed=" + (self.closed ? 1 : 0));
            if (self.closed) return;
            if (self.showSelectPanel(s)) return;
            probeLog("PANEL_BUILD_FAIL");
            // 面板建不起来：回退直接复制。具体失败原因 showSelectPanel 的
            // fail() 已经 Toast 过了，这里不再重复提示。
            self.selectPanelFailed = true;
            self.selectPanelDone = false;
            self.deliverTextDirect(s, self.pendingPick ? self.pendingPick.hp : null,
                                self.pendingPick ? self.pendingPick.rect : undefined);
          }}), delay);
        } catch(ePostPanel) {
          this.selectPanelDone = false;
          this.selectPanelFailed = true;
        }
        opened = (this.selectPanelDone === true);
        if (opened) return true;
      }
      if (!opened && skipWhy !== "面板已打开") {
        panelNotice("未弹面板：" + (skipWhy || "建面板失败") + "，已直接复制");
      }
      return this.deliverTextDirect(s, hp, rect);
    };

    app.deliverTextDirect = function(text, hp, rect) {
      var s = String(text || "");
      probeLog("DIRECT len=" + s.length);
      if (hp === undefined || hp === null) { try { hp = this.hotspot(); } catch(eHp2) { hp = { x: 0, y: 0 }; } }
      if (rect === undefined) rect = this.currentTextRect;
      var result = makeResult(true, "text_pick", "TEXT_PICK_SUCCESS", "取字成功", s, {
        hitPoint: pointToJson(hp.x, hp.y),
        rect: rectToJson(rect)
      });
      try { this.applyFrameState(1, true); } catch(eFrameReady) {}
      try { this.close(); } catch(eClose) {}
      finishWithJson(result);
      return true;
    };


    // ===== V7.34：取字结果选择面板 =====
    // 三条硬约束（每一条都是真机换来的，别再改回去）：
    //   1. 面板里**不能有 TextView**。脚本跑在 system_server，TextView.onDraw
    //      里的 Paint.setColor 会抛 IllegalArgumentException（"Invalid ID: 24"，
    //      高 8 位 alpha 被当成 ColorSpace id），异常无人接 = 系统重启。
    //      所以整块面板离屏画到一张 Bitmap 上，屏幕上只有一个 ImageView。
    //   2. 面板**不新建窗口**：作为监视窗（FrameLayout）的子 View 挂上去。
    //   3. 点击不靠子 View，靠矩形命中（ImageView 必须保持不可点击，否则
    //      它会把 ACTION_DOWN 吃掉，事件到不了监视窗）。
    //
    // 配色跟随系统深色模式：panelTheme = "auto"（默认）/ "light" / "dark"。
    // 每次重画都重新读一次 uiMode，所以开着面板切换深色模式也会跟着变。

    // 当前是否深色模式
    app.panelIsNight = function() {
      if (this.panelTheme === "dark") return true;
      if (this.panelTheme === "light") return false;
      try {
        var cfg = context.getResources().getConfiguration();
        var mode = Number(cfg.uiMode) & 0x30;        // UI_MODE_NIGHT_MASK
        return mode === 0x20;                        // UI_MODE_NIGHT_YES
      } catch(eUn) { return false; }
    };

    // 两套配色。颜色一律用 [a, r, g, b] 数组，绘制时走 Paint.setARGB
    // （四个小整数），绕开 setColor(int) 的 ColorSpace 校验那条路。
    app.panelPalette = function(night) {
      // V7.51：配色表缓存。原来是每次调用新建两个对象 + 十三个数组，
      // 滚动帧每秒上百次调用 = 每秒上千个临时对象，GC 一抖就掉帧。
      // 配色只跟夜色有关，按 key 缓存即可（返回的对象只读，调用方不许改）。
      var key = night ? 1 : 0;
      var c = this._palCache;
      if (c && c.key === key) return c.P;
      if (night) {
        var Pn = {
          bg:        [255,  30,  31,  34],   // #1E1F22 卡片底
          border:    [255,  62,  66,  73],   // #3E4249 1px 描边（深色下没有投影，靠它分界）
          title:     [255, 236, 239, 243],   // #ECEFF3
          hint:      [255, 138, 146, 156],   // #8A929C
          chipOnBg:  [255,  36,  66, 104],   // #244268 选中：深蓝底
          chipOnTx:  [255, 226, 238, 250],   // #E2EEFA 选中文字
          chipOffBg: [255,  45,  47,  52],   // #2D2F34 未选：浅一档的灰
          chipOffTx: [255, 162, 170, 181],   // #A2AAB5 未选文字（V7.52：原 #7C848E 只有 3.5，读不清）
          btnBg:     [255,  45,  47,  52],   // #2D2F34
          btnTx:     [255, 198, 205, 214],   // #C6CDD6
          accBg:     [255,  47, 111, 233],   // #2F6FE9 主按钮（白字对比度 4.6，纯 #3B82F6 只有 3.7）
          accTx:     [255, 255, 255, 255],
          sep:       [255,  74,  79,  88],   // #4A4F58 分区线（比描边亮一档，暗底上看得见）
          scroll:    [120, 205, 213, 224]    // V7.46 滚动条拇指（半透明，别抢字的视觉）
        };
        this._palCache = { key: 1, P: Pn };
        return Pn;
      }
      var Pl = {
        bg:        [255, 255, 255, 255],
        border:    [255, 255, 255, 255],   // 浅色下边框 = 底色，视觉上无边
        title:     [255,  17,  17,  17],
        hint:      [255, 120, 127, 136],   // #787F88 次要文字（对比度 4.2，别再用 154 那种读不清的灰）
        chipOnBg:  [255, 216, 233, 251],
        chipOnTx:  [255,  17,  17,  17],
        chipOffBg: [255, 241, 243, 245],
        chipOffTx: [255,  88,  96, 108],   // #58606C 未选文字（V7.52：原 #7A828C 只有 3.5，读不清）
        btnBg:     [255, 241, 243, 245],
        btnTx:     [255,  68,  74,  82],
        accBg:     [255,  37,  99, 235],   // #2563EB 主按钮（白字对比度 5.2）
        accTx:     [255, 255, 255, 255],
        sep:       [255, 214, 219, 226],   // #D6DBE2 分区线（白底上 1.5:1，够看出来但不抢眼）
        scroll:    [110, 120, 127, 136]    // V7.46 滚动条拇指
      };
      this._palCache = { key: 0, P: Pl };
      return Pl;
    };

    app.showSelectPanel = function(text) {
      var self = this;
      // V7.35：截图模式下面板是「这张图里的文字，你要哪些」，
      // 取字模式是「这行字你要哪些」。文案分开，按钮动作不变。
      var isArea = (this.panelKind === "area");
      probeLog("PANEL_ENTER src_len=" + String(text || "").length + " kind=" + (isArea ? "area" : "text"));
      var fail = function(reason) {
        try { probeLog("PANEL_FAIL " + reason); } catch(eF1) {}
        // V7.35：截图模式下面板失败不等于交付失败 —— 图照样交付，只是
        // 用户没得挑。文案必须说清，否则用户会以为截图也丢了。
        panelNotice("面板未打开：" + reason + (isArea ? "，已按原流程处理" : "，已直接复制"));
        return false;
      };
      var wm = this.wm;
      if (!wm) return fail("没有 WindowManager");
      var host = this.pickWatcher;
      probeLog("PANEL_HOST_CHECK hasHost=" + (host ? 1 : 0));
      if (!host) return fail("监视窗已关闭");

      var screenW = Number(this.screenW) || 0;
      var screenH = Number(this.screenH) || 0;
      if (screenW <= 0 || screenH <= 0) return fail("屏幕尺寸异常 " + screenW + "x" + screenH);

      var str = String(text || "");
      // V7.37：初始切块模式。word=按词（默认），char=按字（一个汉字一块）。
      // 面板左下角的按钮可以临时切换，切过之后本次会话沿用（self.panelMode）。
      var mode = (this.panelMode === "char") ? "char" : "word";
      if (!str.length) return fail("分词为空");
      // V7.38：char 模式不合并相邻块（合并了就不是"单字"）。
      // V7.46：装不下不再分页，改成**连续滚动** —— 全量块在"内容坐标"里
      // 一次排完，文字区可视高度封顶，滚动靠 scrollY 做像素偏移。
      var segsAll = [];      // 全量块（每个带 gi 全局索引）
      // 注意：**不要再搞一个 segs 别名指向 segsAll** —— buildAll 会整体替换
      // segsAll，别名会留在旧数组上（V7.46 第一版就踩了这个：块画了、字没画）。
      var selected = [];
      var layout = null;
      var scrollY = 0;       // 文字区滚动偏移（像素，0..layout.maxScroll）
      // V7.55：缩略图。截图线程里已经缩好了，这里只是拿个引用 ——
      // 面板主线程绝不解码/缩放（那会把 OCR 后的 100ms 又还回去）。
      var thumbBmp = this.areaThumb || null;
      // V7.57：原来这里要算一行「宽 × 高 · 体积」贴在缩略图下面。图本身就在
      // 面板上，尺寸/体积属于自证信息，还白占 18dp，整块撤掉（含布局里的
      // THUMB_LABEL_H）—— 缩略图下面直接就是按钮排。

      // 输入回调用完再动内容与窗口
      try { if (this.pointer) this.pointer.setAlpha(0); } catch(eA) {}
      try { this.hideFrameSoft(); } catch(eF) {}

      // ===== 尺寸与字号 =====
      var panelW = Math.min(Math.round(screenW * 0.92), dp(560));
      if (panelW < dp(240)) panelW = dp(240);
      var PAD = dp(16);
      var innerW = panelW - PAD * 2;
      var spD = 1;
      try { spD = context.getResources().getDisplayMetrics().scaledDensity; } catch(eSp) {}
      var TS_T = 15 * spD;         // 标题
      var TS_H = 11 * spD;         // 提示/计数
      // V7.78：词块 17→15sp、块高 30→27dp、块间距 5→3dp、块内留白 14→11dp。
      // V7.79：字号不动，只把「框」再收一圈 —— 留白 11→8dp、块高 27→25dp、
      // 间距 3→2dp。单块占位 29×30dp → 24×27dp。
      // 15sp 的字在 25dp 高的框里上下各剩 5dp，这是这套配色的下限：再矮
      // 字就会贴到圆角上，选中态的蓝底看起来像「被裁掉一圈」。
      var TS_C = 15 * spD;         // 词块
      var TS_B = 12 * spD;         // 按钮
      var CHIP_H = dp(25);
      var CHIP_GAP = dp(2);
      var CHIP_R = dp(6);          // 块圆角：块高 25dp 时 6dp 仍是「圆角」不是「胶囊」
      var CHIP_PADX = dp(8);       // V7.79：块内左右留白（V7.78 是 11，原来写死 14）
      var BTN_H = dp(34);
      var TITLE_H = dp(26);
      var HINT_H = dp(20);
      var FOOT_GAP = dp(9);         // V7.79：14→9，文字区底到分隔线
      // V7.55：截图模式新增的两块
      var THUMB_GAP = dp(10);       // 缩略图 与 按钮 的间距
      var THUMB_MAX_H = dp(108);    // V7.56：180→108，把高度还给文字区
      // V7.57：缩略图下面那行尺寸/体积已撤掉（原 THUMB_LABEL_H=18dp）。
      // V7.56：文字区与缩略图之间的 1dp 分割线。上下各留呼吸，线本身
      // 至少 1px —— dp(1)*2.75 会取整成 2px，在高密度屏上并不算粗。
      var SEP_H = Math.max(1, Math.round(spD));
      // V7.79：12→8 / 10→8。分离的是「文字」和「缩略图」，8dp 已经能把两块
      // 分开；再多就是纯留白，而这些留白直接等于少排一行字。
      var SEP_TOP = dp(8);
      var SEP_BOTTOM = dp(8);
      var maxPanelH = Math.round(screenH * 0.68);

      var tp = new android.graphics.Paint();
      tp.setAntiAlias(true);
      function txtW(t, size) {
        try {
          tp.setTextSize(size);
          return Number(tp.measureText(String(t)));
        } catch(eM) {
          return String(t).length * size * 0.6;
        }
      }

      // V7.37/V7.38：左下角模式按钮。V7.56 起是一个「词/字」按钮：
      // 两段字并排，当前模式那一段用标题色加粗，另一段用次要色。
      // 它仍然是开关（点一下切），不是二选一的选中项，所以不画高亮底。
      var MODE_TXT = "词/字";
      function modeIsWord() { return mode === "word"; }

      // ===== 纯数据布局：先算每个词块/按钮的矩形，不建任何 View =====
      // V7.46：一次排完全部块，文字区（body）高度封顶 viewH，超出靠 scrollY。
      // chip.y 是**内容坐标**（以 bodyTop 为 0 起算的绝对 y），绘制时减 scrollY，
      // 命中判定时加 scrollY —— 坐标只在这一处约定，别的地方不要自己加减。
      function layoutFor(list) {
        var bodyTop = PAD + TITLE_H + HINT_H;
        var chips = [];
        // V7.51：行表在布局期排好。拖选时每一帧都要"落点在哪一行/哪一块"，
        // 原来每次都把全部块重扫一遍建 rows 数组（几百个对象/MOVE，GC 抖），
        // 现在只按 y 二分这张表，行内再线性找最近块。
        var rowList = [];
        var rowStart = 0;
        var cx = PAD;
        var rowY = bodyTop;
        for (var i = 0; i < list.length; i++) {
          var piece = str.substring(list[i].s, list[i].e);
          // V7.47：字宽只测一次，块宽和居中都用它 —— 渲染时不再重复测量。
          var tw = Math.round(txtW(piece, TS_C));
          var w = tw + CHIP_PADX;
          if (w > innerW) w = innerW;
          if (cx > PAD && cx + w > PAD + innerW) {
            rowList.push({ y: rowY, h: CHIP_H, s: rowStart, e: chips.length });
            rowStart = chips.length;
            cx = PAD;
            rowY += CHIP_H + CHIP_GAP;
          }
          // V7.47：顺手把块文字和它的字宽缓存下来。渲染每帧都要这两样，
          // 原来每帧 substring + measureText 各一次，200 块就是 400 次，
          // 滚动 60fps 下纯属白烧 CPU（substring 还会造一堆临时字符串）。
          chips.push({ x: cx, y: rowY, w: w, h: CHIP_H, gi: list[i].gi,
                       t: piece, tw: tw });
          cx += w + CHIP_GAP;
        }
        rowList.push({ y: rowY, h: CHIP_H, s: rowStart, e: chips.length });
        var chipsBottom = rowY + CHIP_H;
        var contentH = chipsBottom - bodyTop;

        // ===== V7.55/V7.56：截图模式多两块（缩略图 + 分割线）=====
        // 两种模式都只有一行按钮，footH 一致 —— 取字面板的矩形与 V7.54 相同。
        var footH = BTN_H;

        // 缩略图：按位图比例 contain 进 (innerW × THUMB_MAX_H)
        var thumbW = 0, thumbH = 0, thumbAR = 1;
        if (isArea && thumbBmp) {
          var bw = 0, bh = 0;
          try { bw = Number(thumbBmp.getWidth()); bh = Number(thumbBmp.getHeight()); } catch(eBs) { bw = 0; bh = 0; }
          if (bw > 0 && bh > 0) {
            thumbAR = bw / bh;
            thumbW = innerW;
            thumbH = Math.round(innerW / thumbAR);
            if (thumbH > THUMB_MAX_H) {
              thumbH = Math.round(THUMB_MAX_H);
              thumbW = Math.round(thumbH * thumbAR);
            }
            if (thumbW < 1) thumbW = 1;
            if (thumbH < 1) thumbH = 1;
          }
        }

        // 文字区最多这么高：再高卡片就出屏了。超出的部分滚出来。
        // 至少留两行，免得极端屏高把文字区压成一条缝。
        // V7.56：分割线只在有缩略图时画 —— 没有图就没有可分区的东西。
        var sepOn = (thumbH > 0);
        var sepBlockH = sepOn ? (SEP_TOP + SEP_H + SEP_BOTTOM) : 0;
        var thumbBlockH = sepOn ? (sepBlockH + thumbH) : 0;
        var avail = maxPanelH - bodyTop - FOOT_GAP - footH - dp(12);
        // V7.56：avail 里已经扣掉 FOOT_GAP / 按钮 / 底部留白，这里再扣
        // 「分割线 + 缩略图」和它与按钮之间的 THUMB_GAP。
        // 漏掉 THUMB_GAP 会让卡片超出 68% 屏高 —— 1024 宽的小屏上正好
        // 把底部那排按钮推出屏幕。
        var maxBodyH = avail;
        if (thumbBlockH > 0) {
          maxBodyH = avail - thumbBlockH - THUMB_GAP;
          if (maxBodyH < CHIP_H * 2) {
            // 缩略图把文字区挤到两行以下：先把它压扁，压到 60dp 还不行
            // 就整块让位 —— 文字才是这块面板的本体。
            var tH2 = avail - sepBlockH - THUMB_GAP - CHIP_H * 2;
            if (tH2 < dp(60)) {
              thumbW = 0; thumbH = 0; thumbBlockH = 0; sepOn = false; sepBlockH = 0;
              maxBodyH = avail;
            } else {
              thumbH = tH2;
              thumbW = Math.max(1, Math.round(thumbH * thumbAR));
              thumbBlockH = sepBlockH + thumbH;
              maxBodyH = avail - thumbBlockH - THUMB_GAP;
            }
          }
        }
        if (!(maxBodyH > CHIP_H * 2)) maxBodyH = CHIP_H * 2;
        var viewH = (contentH < maxBodyH) ? contentH : maxBodyH;

        var sepY = bodyTop + viewH + FOOT_GAP + SEP_TOP;
        var thumbY = sepOn ? (sepY + SEP_H + SEP_BOTTOM) : (bodyTop + viewH + FOOT_GAP);
        var thumbX = PAD + Math.round((innerW - thumbW) / 2);
        var footerY = sepOn ? (thumbY + thumbH + THUMB_GAP)
                            : (bodyTop + viewH + FOOT_GAP);

        // ===== V7.56：一行按钮 =====
        // 从左到右：词/字 · [分享 · 保存] · 取消 · 清空/全选 · 复制。
        // 六个按钮挤在内宽 400dp 上下时，宽度自适应分三步：
        // ① 缩内边距（24→12dp）② 降字号（14→10sp）③ 等比压窄（兜底）。
        // 「清空」绘制时按 anyOn 换成「全选」，两者都是两个字，宽度不变。
        var btnLabels = isArea ? ["分享", "保存", "取消", "清空", "复制"]
                               : ["取消", "清空", "复制"];
        var btnFs = TS_B;
        var padB = dp(24);
        var gapB = dp(7);
        function modeWFor(fs) { return Math.round(txtW(MODE_TXT, fs)) + dp(18); }
        function rowNeed(fs, pad) {
          var t = modeWFor(fs) + gapB * btnLabels.length;
          for (var bi = 0; bi < btnLabels.length; bi++) {
            t += Math.round(txtW(btnLabels[bi], fs)) + pad;
          }
          return t;
        }
        var minPadB = dp(12);
        while (padB > minPadB && rowNeed(btnFs, padB) > innerW) padB -= dp(2);
        var fsMin = 10 * spD;
        while (btnFs > fsMin && rowNeed(btnFs, padB) > innerW) btnFs -= 0.5 * spD;
        var needW = rowNeed(btnFs, padB);
        var squeeze = (needW > innerW && needW > 0) ? (innerW / needW) : 1;

        var bxRow = PAD;
        function placeBtn(w) {
          if (w < dp(1)) w = dp(1);
          var r = { x: bxRow, y: footerY, w: w, h: BTN_H };
          bxRow += w + gapB;
          return r;
        }
        var rMode = placeBtn(Math.round(modeWFor(btnFs) * squeeze));
        var rByLabel = {};
        for (var bj = 0; bj < btnLabels.length; bj++) {
          var lab = btnLabels[bj];
          rByLabel[lab] = placeBtn(Math.round((Math.round(txtW(lab, btnFs)) + padB) * squeeze));
        }
        var rCopy = rByLabel["复制"];
        var rClear = rByLabel["清空"];
        var rCancel = rByLabel["取消"];
        var rSave = isArea ? rByLabel["保存"] : null;
        var rShare = isArea ? rByLabel["分享"] : null;

        // 命中表：hitSelectPanel 只遍历这张表，不再一个个 if。
        var btns = [{ k: "mode", r: rMode }];
        if (rShare) btns.push({ k: "share", r: rShare });
        if (rSave) btns.push({ k: "save", r: rSave });
        btns.push({ k: "cancel", r: rCancel });
        btns.push({ k: "clear", r: rClear });
        btns.push({ k: "copy", r: rCopy });

        var bottomY = footerY + BTN_H;

        return {
          chips: chips, rowList: rowList, h: bottomY + dp(12),
          copy: rCopy, clear: rClear, cancel: rCancel, mode: rMode,
          save: rSave, share: rShare, btns: btns, btnFs: btnFs,
          bodyTop: bodyTop, viewH: viewH, contentH: contentH,
          thumbX: thumbX, thumbY: thumbY, thumbW: thumbW, thumbH: thumbH,
          sepY: sepY, sepH: sepOn ? SEP_H : 0,
          area: isArea,
          maxScroll: (contentH > viewH) ? (contentH - viewH) : 0
        };
      }

      // V7.46：滚动位置夹紧。内容不够一屏时 maxScroll=0，永远滚不动。
      function clampScroll() {
        var mx = (layout && layout.maxScroll) ? layout.maxScroll : 0;
        if (scrollY > mx) scrollY = mx;
        if (scrollY < 0) scrollY = 0;
      }
      // 重排全部块（换模式时用）。重排后旧的滚动位置没有意义，回到顶部。
      function rebuildLayout() {
        layout = layoutFor(segsAll);
        scrollY = 0;
        clampScroll();
      }

      // ===== V7.37：按模式切块 + 出布局，切换模式时整体重算 =====
      // word 模式先试 ICU 分词，不可用（老 ROM / 类加载失败）就退回按字。
      function buildAll(m) {
        var sg = null;
        var segSrc = "char";                 // V7.80：探针用，看清走的哪条路
        if (m === "word") {
          sg = splitPickWords(str);
          if (sg && sg.length) segSrc = "icu";
          // 分词退化保护：整段只切出 1 块、而原文明显不止一个词 → 说明 ICU
          // 没起作用（词典缺失/被裁），这种块点一下就是全选，比按字还难用，
          // 直接退回按字。短文本（≤5 字）不判，那本来就可能是一个词。
          if (sg && sg.length === 1 && str.length >= 6) { sg = null; segSrc = "char"; }
          if (!sg || !sg.length) {
            sg = splitPickSegments(str, Number(self.selectChunk) || 1);
            segSrc = "char";
          }
          // V7.80：**不再合并相邻块**。V7.37 那个「块数上限 40」是给不会滚动的
          // 文字区准备的（一块画一次、块多就卡）；V7.46 改成滚动之后它只剩一个
          // 副作用 —— 把 4 个相邻词粘成一块，"词"模式看起来就是 7 个字的等分
          // 截断。ICU 切出多少块就排多少块：绘制只画视口内的块，命中走行表
          // 二分，块数不进每帧成本，只影响内容高度（滚动解决）。
          probeLog("PANEL_SEG src=" + segSrc + " chips=" + sg.length);
        } else {
          // 单字模式：一个汉字一块（英文/数字保持整块，标点并进前一块）。
          sg = splitPickSegments(str, Number(self.selectChunk) || 1);
        }
        if (!sg || !sg.length) sg = [{ s: 0, e: str.length }];
        for (var g = 0; g < sg.length; g++) sg[g].gi = g;
        segsAll = sg;

        // V7.46：不再按高度收缩、也不再切页 —— 排不下就滚动。
        // V7.80：两种模式都一个块都不合并（原来 word 模式会把 4 个词粘一块，
        // 那正是"词"模式看着像按字数截断的原因）。
        rebuildLayout();

        // 选中态：V7.40 起**两种模式都默认全不选** —— 面板是"从这段文字里
        // 挑我要的"，先替用户全选上再让他点掉，比让他点选更费事（尤其截图
        // OCR 出来的整屏文字）。要全要就点左下角那个「全选」。
        selected = [];
        for (var q0 = 0; q0 < segsAll.length; q0++) selected.push(false);
        probeLog("PANEL_BUILD mode=" + m + " chips=" + segsAll.length +
                 " contentH=" + layout.contentH + " viewH=" + layout.viewH +
                 " maxScroll=" + layout.maxScroll);
      }

      buildAll(mode);

      // ===== 自绘：整块面板画到一张 Bitmap 上 =====
      // V7.47：Paint 复用。每帧 new 一个是小对象，但 60fps 下每秒 60 个原生
      // 对象，还会让 Skia 每帧重建字体度量缓存 —— 滚动时完全没必要。
      var paintCache = new android.graphics.Paint();
      paintCache.setAntiAlias(true);
      // V7.55：缩略图专用画笔。filter=true 让缩放后的图边缘不锯齿；
      // 和 paintCache 分开是因为 paintCache 每帧都在改字号/颜色/加粗。
      var thumbPaint = new android.graphics.Paint();
      thumbPaint.setAntiAlias(true);
      try { thumbPaint.setFilterBitmap(true); } catch(eTp) {}
      function fillRR(cv, p, x0, y0, x1, y1, r, c) {
        try {
          p.setStyle(android.graphics.Paint.Style.FILL);
          p.setARGB(c[0], c[1], c[2], c[3]);
          cv.drawRoundRect(x0, y0, x1, y1, r, r, p);
        } catch(eFr) {}
      }
      function textC(cv, p, t, x, y, size, c, bold) {
        try {
          p.setTextSize(size);
          p.setFakeBoldText(!!bold);
          p.setARGB(c[0], c[1], c[2], c[3]);
          cv.drawText(String(t), x, y, p);
        } catch(eTx) {}
      }

      // ===== V7.47：文字区绘制抽出来，整画和滚动帧共用 =====
      // 所有块都按"内容坐标"排好，这里统一减 scrollY 落到屏幕上；超出视口的
      // 块直接跳过（不画），边缘被切掉一半的块靠 clip 裁齐，免得盖到标题或
      // 按钮上。裁剪失败也不致命：跳过越界块本身已经挡掉大半。
      // 两边（renderPanel / paintScrollFrame）必须画得一模一样，否则滚动时
      // 会出现"字换了但底色/位置对不上"的错位。
      // V7.51：块绘制批量化。
      // 原来每块要 7 次跨 JNI：setStyle / setARGB(底) / setTextSize /
      // setFakeBold / drawRoundRect / setARGB(字) / drawText。60 个可见块
      // 就是 400+ 次，主线程光这一项 3~8ms —— 滚动发涩的主因之一。
      // 现在按「未选 / 已选」两趟，画笔状态每趟各设一次，每块只剩两次绘制。
      // 另外：块按 y 升序排好，先二分出首个可见块，遇到视口下方直接 break。
      function paintChips(cv, p, P) {
        var vTop = layout.bodyTop;
        var vBot = vTop + layout.viewH;
        var list = layout.chips;
        var n = list.length;
        if (!n) return;
        var sy = scrollY;
        var lo = 0;
        var hi = n;
        while (lo < hi) {
          var mid = (lo + hi) >> 1;
          var cm = list[mid];
          if (cm.y + cm.h - sy > vTop) hi = mid;
          else lo = mid + 1;
        }
        var clipped = false;
        try {
          cv.save();
          cv.clipRect(0, vTop, panelW, vBot);
          clipped = true;
        } catch(eClip) {}
        try {
          p.setStyle(android.graphics.Paint.Style.FILL);
          p.setTextSize(TS_C);
          p.setFakeBoldText(false);
          for (var pass = 0; pass < 2; pass++) {
            var on = (pass === 1);
            var bg = on ? P.chipOnBg : P.chipOffBg;
            var tc = on ? P.chipOnTx : P.chipOffTx;
            var any = false;
            p.setARGB(bg[0], bg[1], bg[2], bg[3]);
            for (var i2 = lo; i2 < n; i2++) {
              var chip = list[i2];
              var cy = chip.y - sy;
              if (cy >= vBot) break;                 // 后面都在视口下方
              if (cy + chip.h <= vTop) continue;     // 还没进视口
              if ((!!selected[chip.gi]) !== on) continue;
              cv.drawRoundRect(chip.x, cy, chip.x + chip.w, cy + chip.h,
                               CHIP_R, CHIP_R, p);
              any = true;
            }
            if (!any) continue;
            p.setARGB(tc[0], tc[1], tc[2], tc[3]);
            var base = TS_C * 0.34;
            for (var i3 = lo; i3 < n; i3++) {
              var c2 = list[i3];
              var cy2 = c2.y - sy;
              if (cy2 >= vBot) break;
              if (cy2 + c2.h <= vTop) continue;
              if ((!!selected[c2.gi]) !== on) continue;
              // 文字和字宽都是布局时算好的
              var t2 = c2.t;
              if (t2 === undefined) {
                var sg2 = segsAll[c2.gi];
                t2 = sg2 ? str.substring(sg2.s, sg2.e) : "";
              }
              var tw2 = (c2.tw !== undefined) ? c2.tw : txtW(t2, TS_C);
              cv.drawText(String(t2), c2.x + (c2.w - tw2) / 2,
                          cy2 + c2.h / 2 + base, p);
            }
          }
        } catch(eCp) {
          probeLog("PANEL_CHIPS_FAIL " + String(eCp && eCp.message ? eCp.message : eCp));
        }
        try { if (clipped) cv.restore(); } catch(eRs) {}

        // 滚动条：只在真能滚时出现，画在文字区右缘的留白里（不压字）
        if (layout.maxScroll > 0) {
          var trackTop = vTop + dp(2);
          var trackH = layout.viewH - dp(4);
          var thumbH = Math.round(trackH * layout.viewH / layout.contentH);
          if (thumbH < dp(24)) thumbH = dp(24);
          if (thumbH > trackH) thumbH = trackH;
          var thumbY = trackTop + Math.round((trackH - thumbH) * (scrollY / layout.maxScroll));
          fillRR(cv, p, panelW - dp(8), thumbY, panelW - dp(4), thumbY + thumbH,
                 dp(2), P.scroll);
        }
      }

      // ===== V7.47：滚动帧 —— 只重画文字区，固定层一个像素都不碰 =====
      // 前提是这张位图上已经有一份完整画面（info._poolReady），所以边框、
      // 标题、"已选 N 字"、提示行、四个按钮全都还在，只有文字区需要重铺。
      // 一帧的成本从上万次绘制降到"铺一块矩形 + 画视口里那几十块"。
      function paintScrollFrame(target) {
        var P = self.panelPalette(self.panelIsNight());
        var cv = new android.graphics.Canvas(target);
        var p = paintCache;
        // 先拿卡片底色把整个文字区盖掉（上一帧的字和滚动条都在这块里）。
        // 左右各留 1dp：卡片内层是从 1 开始的，别擦到那圈描边。
        try {
          p.setStyle(android.graphics.Paint.Style.FILL);
          p.setARGB(P.bg[0], P.bg[1], P.bg[2], P.bg[3]);
          cv.drawRect(1, layout.bodyTop, panelW - 1,
                      layout.bodyTop + layout.viewH, p);
        } catch(eBg) {}
        paintChips(cv, p, P);
      }

      // target 传进来就画在这张上（先清空），不传就新建一张。
      // V7.47 起滚动帧走"传进来"这条路：位图是预分配好轮换用的，
      // 不再每帧 createBitmap —— 那才是卡顿的根因（4MB 分配 + GC 停顿）。
      function renderPanel(target) {
        var night = self.panelIsNight();
        var P = self.panelPalette(night);
        var bmp = target;
        if (bmp) {
          try { bmp.eraseColor(0); } catch(eEr) {}
        } else {
          bmp = android.graphics.Bitmap.createBitmap(panelW, layout.h,
            android.graphics.Bitmap.Config.ARGB_8888);
        }
        var cv = new android.graphics.Canvas(bmp);
        var p = paintCache;

        // 卡片：先铺边框色，再铺内层 —— 等于 1dp 描边。
        // 深色下没有系统投影可用，靠这一圈描边把卡片从背景里分出来。
        fillRR(cv, p, 0, 0, panelW, layout.h, dp(18), P.border);
        fillRR(cv, p, 1, 1, panelW - 1, layout.h - 1, dp(17), P.bg);

        // 标题 + 已选字数
        textC(cv, p, isArea ? "已截图 · 选择文字" : "选择文字",
              PAD, PAD + dp(17), TS_T, P.title, true);
        var nSel = 0;
        for (var q = 0; q < segsAll.length; q++) if (selected[q]) nSel += (segsAll[q].e - segsAll[q].s);
        var cnt = "已选 " + nSel + " 字";
        textC(cv, p, cnt, panelW - PAD - txtW(cnt, TS_H), PAD + dp(17), TS_H, P.hint, false);

        // 提示。V7.36 起「取消」不再复制整段，文案必须跟着改。
        // V7.40：默认一个都不选，提示得先讲"选好再复制"。
        // V7.45：能滚时得告诉用户怎么滚 —— 否则他根本不知道空白处能上下滑，
        // 或者按在字上往上滑，结果选了一大片还以为坏了。
        // V7.46：翻页 → 滚动，文案跟着改成"滚动"。
        // V7.56：滚动手势限定在文字区，文案里的"空白"必须写明是"文字区空白"
        //        —— 缩略图那块空白已经不响应滚动了，不写清楚会被当成坏了。
        var scrollable = (layout.maxScroll > 0);
        var hintTxt;
        if (scrollable) {
          hintTxt = "点选/拖动选字；文字区空白上下滑";
          if (txtW(hintTxt, TS_H) > innerW) hintTxt = "点选/拖动；文字区空白上下滑";
        } else {
          hintTxt = isArea ? "点选文字，再点复制/保存/分享"
                           : "点或框选文字，选好点复制；点面板外取消";
          if (txtW(hintTxt, TS_H) > innerW) {
            hintTxt = isArea ? "点选文字后复制/保存/分享" : "点或框选；点面板外取消";
          }
        }
        textC(cv, p, hintTxt, PAD, PAD + TITLE_H + dp(12), TS_H, P.hint, false);

        // ===== V7.46/V7.47：文字区（可滚动视口） =====
        paintChips(cv, p, P);

        // ===== V7.56：文字区与缩略图之间的分区线 =====
        // 两段内容原来首尾相接，用户分不清「哪到哪是文字」。1dp 通栏线 +
        // 上下各 10dp 留白，一眼能看出是两个区。
        if (layout.sepH > 0) {
          try {
            p.setStyle(android.graphics.Paint.Style.FILL);
            p.setARGB(P.sep[0], P.sep[1], P.sep[2], P.sep[3]);
            cv.drawRect(PAD, layout.sepY, panelW - PAD, layout.sepY + layout.sepH, p);
          } catch(eSepD) {}
        }

        // ===== V7.55：截图缩略图 =====
        // 先铺一圈描边色，再把图按圆角裁进去 —— 竖屏长图只能窄成一条，
        // 所以用 contain 居中，两侧留白，不拉伸也不裁切。
        if (layout.thumbW > 0 && thumbBmp) {
          var tx = layout.thumbX, ty = layout.thumbY;
          var tw2 = layout.thumbW, th2 = layout.thumbH;
          fillRR(cv, p, tx - 1, ty - 1, tx + tw2 + 1, ty + th2 + 1, dp(10), P.border);
          var drew = false;
          try {
            var dst = new android.graphics.Rect(tx, ty, tx + tw2, ty + th2);
            cv.save();
            try {
              var path = new android.graphics.Path();
              path.addRoundRect(new android.graphics.RectF(tx, ty, tx + tw2, ty + th2),
                                dp(9), dp(9), android.graphics.Path.Direction.CW);
              cv.clipPath(path);
              cv.drawBitmap(thumbBmp, null, dst, thumbPaint);
              drew = true;
            } finally {
              cv.restore();
            }
          } catch(eThD) { drew = false; }
          if (!drew) {
            // 圆角裁剪失败（个别 ROM 的 clipPath 不认 RectF）也要把图画出来，
            // 直角总比空白强。
            try {
              cv.drawBitmap(thumbBmp, null,
                new android.graphics.Rect(tx, ty, tx + tw2, ty + th2), thumbPaint);
            } catch(eThD2) {}
          }
        }

        // ===== 一行按钮 =====
        // V7.56：改成遍历布局期排好的 btns 表 —— 每个按钮的位置/宽度都在
        // layoutFor 里定好了（含自适应缩字号），这里只负责画，不再重复算。
        var anyOn = false;
        for (var a2 = 0; a2 < selected.length; a2++) if (selected[a2]) { anyOn = true; break; }
        var btnFs = layout.btnFs || TS_B;
        var btnRow = layout.btns || [];
        var lblOf = { share: "分享", save: "保存", cancel: "取消", copy: "复制" };
        for (var bq = 0; bq < btnRow.length; bq++) {
          var bIt = btnRow[bq];
          var br = bIt.r;
          var by = br.y + BTN_H / 2 + btnFs * 0.35;
          if (bIt.k === "mode") {
            // 「词/字」：当前那半边用标题色加粗，另一半用次要色。
            fillRR(cv, p, br.x, br.y, br.x + br.w, br.y + br.h, dp(10), P.btnBg);
            var onW = modeIsWord();
            var wW = txtW("词", btnFs);
            var wS = txtW("/", btnFs);
            var wZ = txtW("字", btnFs);
            var mX = br.x + Math.max(1, (br.w - (wW + wS + wZ)) / 2);
            textC(cv, p, "词", mX, by, btnFs, onW ? P.title : P.hint, onW);
            textC(cv, p, "/", mX + wW, by, btnFs, P.hint, false);
            textC(cv, p, "字", mX + wW + wS, by, btnFs, onW ? P.hint : P.title, !onW);
            continue;
          }
          // V7.39：两种模式都能多选，按钮在「清空 / 全选」之间换字
          var lb = (bIt.k === "clear") ? (anyOn ? "清空" : "全选") : (lblOf[bIt.k] || "");
          // V7.75：复制是「确认」按钮，只有真的选到字才亮成蓝底白字。
          // 一个字都没选时它和「取消/清空」同款灰底 —— 一眼就能看出还差
          // 「选字」这一步，不会再出现"按钮永远是亮色、点了没反应"。
          var acc = (bIt.k === "copy") && anyOn;
          fillRR(cv, p, br.x, br.y, br.x + br.w, br.y + br.h, dp(10),
                 acc ? P.accBg : P.btnBg);
          textC(cv, p, lb, br.x + (br.w - txtW(lb, btnFs)) / 2, by, btnFs,
                acc ? P.accTx : P.btnTx, acc);
        }

        return bmp;
      }

      // V7.50：固定层指纹。滚动帧只重铺文字区，固定层（卡片描边、标题、
      // 「已选 N 字」、提示行、四个按钮）直接沿用备用位图上的旧像素 ——
      // 而备用那张是**上一次整画**留下的，可能比当前状态旧一代。选中几块
      // 再滚动，两张位图轮流上屏、各带一份旧计数，右上角数字就来回跳。
      // 这里把固定层里会变的东西拼成指纹（字数、全选/清空按钮文字、模式、
      // 夜间），每次整画时记到那张位图名下；滚动前对不上宁可整画一帧。
      function fixedSig() {
        var n = 0;
        for (var fs = 0; fs < segsAll.length; fs++) {
          if (selected[fs]) n += (segsAll[fs].e - segsAll[fs].s);
        }
        var any = 0;
        for (var fa = 0; fa < selected.length; fa++) {
          if (selected[fa]) { any = 1; break; }
        }
        return n + "|" + any + "|" + mode + "|" + (self.panelIsNight() ? 1 : 0);
      }

      var bmp0 = null;
      try {
        bmp0 = renderPanel();
      } catch(eR0) {
        var m0 = String(eR0 && eR0.message ? eR0.message : eR0);
        probeLog("PANEL_RENDER_FAIL " + m0);
        return fail("绘制位图失败 " + m0);
      }
      probeLog("PANEL_RENDER_OK " + panelW + "x" + layout.h + " chars=" + segsAll.length +
               " scroll=" + Math.round(scrollY) + "/" + layout.maxScroll +
               " night=" + (self.panelIsNight() ? 1 : 0));

      // ===== 面板本体：只有一个 ImageView，贴图完事 =====
      var panel = new android.widget.ImageView(context);
      try { panel.setScaleType(android.widget.ImageView.ScaleType.FIT_XY); } catch(eSt) {}
      // 故意不设 clickable：设了之后 ImageView 会把 ACTION_DOWN 吃掉，
      // 事件就再也传不到监视窗的 onTouchListener，命中判定全废。
      try {
        panel.setImageBitmap(bmp0);
      } catch(eIb) {
        try { bmp0.recycle(); } catch(eRb0) {}
        return fail("设置位图失败");
      }

      var cardLp = new android.widget.FrameLayout.LayoutParams(panelW, layout.h);
      cardLp.gravity = android.view.Gravity.CENTER;
      probeLog("PANEL_ADD_BEGIN(host)");
      var added = false;
      try {
        host.addView(panel, cardLp);
        added = true;
      } catch(eAdd) {
        probeLog("PANEL_ADD_ERR " + String(eAdd && eAdd.message ? eAdd.message : eAdd));
      }
      probeLog(added ? "PANEL_ADD_OK" : "PANEL_ADD_FAIL");
      if (!added) {
        try { bmp0.recycle(); } catch(eRb1) {}
        return fail("挂到监视窗失败");
      }

      var info = {
        root: panel, host: host, bmp: bmp0, layout: layout,
        segs: segsAll, text: str, selected: selected, mode: mode,
        w: panelW, h: layout.h
      };
      // ===== V7.47：双缓冲位图池 =====
      // V7.46 每帧都 createBitmap 一张 4MB 新图，旧的还要延迟 500ms 才回收 ——
      // 滚动 60ms 一帧时同时挂着十几张，GC 一停主线程就卡，滑起来发涩。
      // 现在预分配两张轮换：画 A 贴 A、A 下线后当下一帧的画布，运行期零分配。
      // 代价是常驻 8MB（固定），换来的是滚动时不再有任何大对象产生。
      info._pool = null;       // 当前不在显示的那张（下一帧当画布用）
      info._poolReady = false; // 池里那张是否已有一份完整画面（固定层画全了）
      // V7.50：这两张位图各自的固定层指纹。bmp0 刚由 renderPanel() 整画过，
      // 记的就是当下状态；池里还没有图，指纹留空。
      info._bmpSig = fixedSig();
      info._poolSig = null;

      function bmpFits(b) {
        try {
          return !!(b && !b.isRecycled() &&
                    b.getWidth() === panelW && b.getHeight() === layout.h);
        } catch(eBf) { return false; }
      }
      // 取"当前不在显示"的那张；没有或尺寸不符（换模式后高度变了）就补一张
      function ensureFrameBmp() {
        if (bmpFits(info._pool)) return info._pool;
        // 绝不回收正在显示的那张 —— 正常流程里 _pool 永远不是 info.bmp，
        // 但万一哪天写岔了，回收显示中的位图 = 系统重启，加道保险。
        try {
          if (info._pool && info._pool !== info.bmp) info._pool.recycle();
        } catch(eRp) {}
        info._pool = null;
        info._poolReady = false;
        info._poolSig = null;
        try {
          info._pool = android.graphics.Bitmap.createBitmap(panelW, layout.h,
            android.graphics.Bitmap.Config.ARGB_8888);
        } catch(eFb2) { info._pool = null; }
        return info._pool;
      }
      // 旧位图**不能立刻 recycle**：硬件渲染里上一帧的 DisplayList 可能还
      // 引用着它，回收后下一次 traversal 会抛 "trying to use a recycled
      // bitmap"，而这里抛异常 = 系统重启。推迟再回收。
      function recycleLater(b, ms) {
        if (!b) return;
        try {
          self.handler.postDelayed(new java.lang.Runnable({ run: function() {
            try { b.recycle(); } catch(eRc) {}
          }}), Number(ms) > 0 ? Number(ms) : 3000);
        } catch(eRc2) {}
      }

      // 整画：选中态变化、换模式、首次显示都走这里（换图即可，不重建 View）
      info.redraw = function(recycleMs) {
        try {
          var rsig = fixedSig();
          var target = ensureFrameBmp();
          var nb = null;
          if (target) {
            // 池里这张可能已被系统回收/尺寸不符，画失败就退回新建
            try { nb = renderPanel(target); } catch(eTg1) { nb = null; }
          }
          if (!nb) {
            // 池里那张画不出来（被系统回收/尺寸不符）就丢掉，别下一帧继续用
            if (target) { info._pool = null; recycleLater(target, 0); }
            target = null;
            nb = renderPanel(null);
          }
          var oldBmp = info.bmp;
          var oldSig = info._bmpSig;
          try { panel.setImageBitmap(nb); } catch(eS1) {}
          info.bmp = nb;
          // 这张刚被整画过，固定层 = 当下状态
          info._bmpSig = rsig;
          if (target) {
            // 池模式：刚下线的那张留作下一帧的画布 —— 它上面正是上一帧的
            // 完整画面，所以下一帧的滚动帧可以直接在它上面补文字区。
            // 尺寸不符（换模式后高度变了）就还掉，别留着白占 4MB。
            if (oldBmp && oldBmp !== nb) {
              if (bmpFits(oldBmp)) {
                info._pool = oldBmp;
                info._poolSig = oldSig;   // 它的固定层是上一次整画的内容
              } else {
                info._pool = null;
                info._poolSig = null;
                recycleLater(oldBmp, recycleMs);
              }
            } else {
              info._pool = null;
              info._poolSig = null;
            }
            info._poolReady = true;
          } else {
            info._poolReady = false;
            info._poolSig = null;
            recycleLater(oldBmp && oldBmp !== nb ? oldBmp : null, recycleMs);
          }
        } catch(eR2) {
          probeLog("PANEL_REDRAW_FAIL " + String(eR2 && eR2.message ? eR2.message : eR2));
        }
      };

      // ===== V7.47：滚动帧 —— 只补文字区 =====
      // 固定层（边框/标题/计数/提示/按钮）在滚动期间不可能变：滚动手势只改
      // scrollY，不动选中态、不换模式。所以直接拿备用那张（它已经是上一帧
      // 的完整画面）盖掉文字区重画即可，成本约为整画的 1/4。
      // 万一池还没准备好（刚弹出、刚换模式），退回整画，绝不画半张。
      info.redrawScroll = function() {
        // V7.50：池里那张的固定层必须和**现在**一致。选中态变过（哪怕只是
        // 上一秒改的），它的标题/计数/按钮文字就是旧一代 —— 直接补文字区，
        // 上屏的计数会跳回旧值。对不上就整画一帧，把两张都追平。
        if (!info._poolReady || !bmpFits(info._pool) ||
            info._poolSig !== fixedSig()) { info.redraw(0); return; }
        var target = info._pool;
        var oldBmp = info.bmp;
        var oldSig = info._bmpSig;
        try {
          paintScrollFrame(target);
        } catch(ePsf) {
          probeLog("PANEL_SCROLL_FRAME_FAIL " +
                   String(ePsf && ePsf.message ? ePsf.message : ePsf));
          info.redraw(0);
          return;
        }
        try { panel.setImageBitmap(target); } catch(eS5) {}
        info.bmp = target;
        // 这张的固定层就是校验过的那个指纹
        info._bmpSig = info._poolSig;
        if (oldBmp && oldBmp !== target) {
          info._pool = oldBmp;
          info._poolSig = oldSig;
          info._poolReady = true;
        } else {
          // 没有可轮换的那张（理论上不会发生）就保守一点，下一帧整画。
          // 绝不能把 info.bmp 自己当池 —— 那会在"正在显示的图上作画"。
          info._pool = null;
          info._poolSig = null;
          info._poolReady = false;
        }
      };

      // V7.39：拖动选择的节流重画。手指一帧能发好几个 MOVE，每个都重画
      // 位图会把主线程拖垮。
      // V7.47：滚动改成"只补文字区"后单帧便宜了，间隔从 60ms 降到 16ms
      // （约 60fps）；选字仍 120ms（只有区间边界在变，不需要更快）。
      // 另外一个细节：手一停就攒下一帧、手一动又要等满一个间隔，会把帧率
      // 压到 1/(帧耗时+间隔)。这里按"距上一帧结束多久"扣掉等待时间，
      // 持续拖动时就是稳定的 ~16ms 一帧。
      info._rdLastEnd = 0;
      info._rdKind = "full";
      // V7.51：滚动帧间隔自适应。默认 10ms（贴手）；一旦某一帧实测超过
      // 14ms，说明这台机器画不动更密的帧，退回 16ms 并保持 —— 帧排太密
      // 会把输入事件挤到后面，越追越顿，反而是反效果。
      info._scrollDelay = 10;
      function runFrame() {
        info._rdPending = false;
        var scroll = (info._rdKind === "scroll");
        var t0 = 0;
        try { t0 = java.lang.System.currentTimeMillis(); } catch(eT0) {}
        if (scroll) info.redrawScroll();
        else info.redraw(info._rdRecycle);
        try {
          var t1 = java.lang.System.currentTimeMillis();
          info._rdLastEnd = t1;
          if (scroll && t0 > 0 && (t1 - t0) > 14 && info._scrollDelay < 16) info._scrollDelay = 16;
        } catch(eEnd) {}
      }
      info.requestRedraw = function(delayMs, recycleMs, kind) {
        var isScroll = (kind === "scroll");
        info._rdDelay = (Number(delayMs) > 0) ? Number(delayMs) : 120;
        info._rdRecycle = (Number(recycleMs) > 0) ? Number(recycleMs) : 800;
        // 已经在排队时：滚动请求可以被吸收，但"整画"优先级最高，不能被
        // 一次滚动请求顶掉（否则选中的高亮可能画不出来）。
        if (info._rdPending) {
          if (!isScroll) info._rdKind = "full";
          return;
        }
        info._rdKind = isScroll ? "scroll" : "full";
        info._rdPending = true;
        var dl = isScroll ? info._scrollDelay : info._rdDelay;
        var wait = dl;
        try {
          if (info._rdLastEnd > 0) {
            var gap = java.lang.System.currentTimeMillis() - info._rdLastEnd;
            if (gap < dl) wait = dl - gap;
          }
        } catch(eGap) {}
        if (wait < 0) wait = 0;
        try {
          self.handler.postDelayed(new java.lang.Runnable({ run: runFrame }), wait);
        } catch(eRdq) {
          runFrame();
        }
      };

      // V7.37/V7.38：换页或换模式后，位图尺寸和 ImageView 的 LayoutParams
      // 一起更新，再重画一张。全程只动子 View 的布局，不新建/不销毁窗口。
      info.applyLayout = function() {
        info.layout = layout;
        info.segs = segsAll;
        info.selected = selected;
        info.mode = mode;
        info.h = layout.h;
        clampScroll();
        // 换页/换模式后 chips 变了，旧的拖选区间作废
        info.drag = null;
        try {
          var lp2 = panel.getLayoutParams();
          if (lp2) {
            lp2.width = panelW;
            lp2.height = layout.h;
            panel.setLayoutParams(lp2);
          }
        } catch(eLp2) {}
        info.redraw();
      };

      // V7.37：左下角「单词模式/单字模式」切换。
      info.toggleMode = function() {
        var next = (mode === "word") ? "char" : "word";
        mode = next;
        self.panelMode = next;      // 本次会话沿用：下次开面板还是这个模式
        buildAll(next);
        probeLog("PANEL_MODE " + next + " chars=" + segsAll.length +
                 " maxScroll=" + layout.maxScroll + " h=" + layout.h);
        info.applyLayout();
      };

      // V7.46：滚动 API。滚不动就返回 false（内容只有一屏时调用方不用管）。
      // 用闭包里的 scrollY，而不是 info 上的字段 —— 渲染、命中、手势都读这一份。
      info.getScroll = function() { return scrollY; };
      info.maxScroll = function() { return layout.maxScroll || 0; };
      info.scrollTo = function(y) {
        var before = scrollY;
        var v = Number(y);
        scrollY = isFinite(v) ? v : 0;
        clampScroll();
        if (scrollY !== before) {
          // V7.51：10ms。单帧已经压到 2~4ms，提前一点排队就能贴着手走；
          // 慢机上单帧超 14ms 会自己退避回 16ms（见 requestRedraw）。
          info.requestRedraw(10, 0, "scroll");
          return true;
        }
        return false;
      };
      info.scrollBy = function(dy) {
        return info.scrollTo(scrollY + (Number(dy) || 0));
      };

      this.selectPanelInfo = info;
      this.selectPanelDone = true;
      // V7.54：截图链路才带计时。d  = OCR 出结果 → 面板可见（建面板的开销）
      //              d0 = 松手 → 面板可见（用户的真实等待）
      var shownMsg = "PANEL_SHOWN w=" + panelW + " h=" + layout.h + " chars=" + segsAll.length +
                     " maxScroll=" + layout.maxScroll + " mode=" + mode;
      if (this.panelKind === "area") {
        var tShown = nowMs();
        if (this.areaOcrDoneAt > 0) shownMsg += " d=" + (tShown - this.areaOcrDoneAt);
        if (this.areaT0 > 0) shownMsg += " d0=" + (tShown - this.areaT0);
      }
      probeLog(shownMsg);

      // 挂上之后回头看一眼有没有尺寸、有没有真的显示
      try {
        this.handler.postDelayed(new java.lang.Runnable({ run: function() {
          try {
            var cw = panel.getWidth();
            var chh = panel.getHeight();
            var vis = panel.isShown() ? 1 : 0;
            var att = 1;
            try { att = host.isAttachedToWindow() ? 1 : 0; } catch(eAt) {}
            // V7.53：把「面板在屏幕上的绝对位置」也打出来。之前只有 w/h/shown，
            // 面板要是被 gravity 摆到屏幕外，shown 依然是 1 —— 日志看着一切正常，
            // 用户却什么都看不见（还能盲点、能拖动、能点外面取消）。
            var px = -1, py = -1, hw = 0, hh2 = 0, off = 0;
            try {
              var loc = java.lang.reflect.Array.newInstance(java.lang.Integer.TYPE, 2);
              panel.getLocationOnScreen(loc);
              px = Number(loc[0]);
              py = Number(loc[1]);
            } catch(eLoc) {}
            try { hw = host.getWidth(); hh2 = host.getHeight(); } catch(eHs) {}
            if (px !== -1 && (px + cw <= 0 || py + chh <= 0)) off = 1;
            probeLog("PANEL_GEOM w=" + cw + " h=" + chh + " shown=" + vis +
                     " hostAttached=" + att + " at=" + px + "," + py +
                     " host=" + hw + "x" + hh2 + " screenOff=" + off);
            // V7.74：这里原来还有一条 panelNotice("面板已挂上但不可见(…)")，
            // 是纯几何诊断，probe 里的 PANEL_GEOM 已经记全了，删掉这条屏上噪音。
          } catch(eGeo) {}
        }}), 160);
      } catch(eGeoPost) {}

      // V7.48：这里原来挂的是 selectPanelTimeout（60s 无操作自动取消），已删。
      // 同时补两件事：
      //   ① 撤掉 300s 全局看门狗 —— 它是「finishWithJson 漏调」的兜底，而
      //      面板期的空闲是用户在读字，不是挂死。不撤的话「超时消失」只是
      //      从 60s 变成 300s。
      //   ② 另起 PanelHoldWatch —— 只防「会话真挂死」（面板挂住会连带留下
      //      全屏监视窗，整机触摸都废）。时长 selectPanelHoldMs 默认 30 分钟。
      try { if (GlobalWatchdog) { GlobalWatchdog.cancel(); GlobalWatchdog = null; } } catch(eWdP) {}
      cancelPanelHold();
      try {
        var holdMs = Number(this.selectPanelHoldMs);
        if (isNaN(holdMs) || holdMs < 0) holdMs = 0;
        if (holdMs > 0) {
          PanelHoldWatch = new java.util.Timer("ShortXPanelHoldWatch", true);
          PanelHoldWatch.schedule(new JavaAdapter(java.util.TimerTask, { run: function() {
            try {
              if (!self.selectPanelInfo) return;   // 面板已关，本次无需收尾
              probeLog("PANEL_HOLD_TIMEOUT ms=" + holdMs);
              try { if (PointerRuntimeRef && PointerRuntimeRef.close) PointerRuntimeRef.close(); } catch(eHc) {}
              finishError("pointer_error", "PANEL_HOLD",
                          "面板停留超过 " + Math.round(holdMs / 1000) + " 秒，已强制收尾");
            } catch(eHt) {}
            try { if (PanelHoldWatch) { PanelHoldWatch.cancel(); PanelHoldWatch = null; } } catch(eHc2) {}
          }}), holdMs);
        }
      } catch(eHold) { PanelHoldWatch = null; }
      return true;
    };

    // 矩形命中判定：面板是位图，没有子 View 能接点击，全靠这里算
    app.hitSelectPanel = function(lx, ly) {
      var info = this.selectPanelInfo;
      if (!info || !info.layout) return "";
      var L = info.layout;
      if (lx < 0 || ly < 0 || lx > info.w || ly > info.h) return "outside";
      // V7.46：chips 存的是"内容坐标"，这里先加 scrollY 换算成屏幕坐标；
      // 并且只有落在文字视口内的点才算命中（滚出去的块不许被点到）。
      var ch = L.chips || [];
      var sy = (info.getScroll ? info.getScroll() : 0);
      var vTop = L.bodyTop || 0;
      var vBot = vTop + (L.viewH || 0);
      if (ly >= vTop && ly <= vBot) {
        var yy = ly + sy;
        for (var i = 0; i < ch.length; i++) {
          var c = ch[i];
          if (lx >= c.x && lx <= c.x + c.w && yy >= c.y && yy <= c.y + c.h) {
            return "chip:" + ((c.gi === undefined) ? i : c.gi);
          }
        }
      }
      // V7.56：按钮都在同一行，命中表由布局期排好（btns），这里只遍历 ——
      // 增删按钮不用再改这里，也不会出现"加了按钮忘了加命中"。
      var bl = L.btns || [];
      for (var bi2 = 0; bi2 < bl.length; bi2++) {
        var br = bl[bi2].r;
        if (br && lx >= br.x && lx <= br.x + br.w &&
            ly >= br.y && ly <= br.y + br.h) {
          return bl[bi2].k;
        }
      }
      return "inside";     // 卡片内空白处：什么都不做
    };

    // V7.49：**严格**命中 —— 点是否真落在字上（文字宽度 + dp(3)，纵向内缩 2dp）。
    // 为什么不直接改 hitSelectPanel：那一个还负责抬手点选，需要块矩形的宽松
    // 容差（块宽 = 字宽 + 14dp，点偏一点也算点中）。而手势起手必须严格：
    // 块底色和卡片底几乎同色，用户看不出块边界，按在字旁边的留白他认为是
    // 空白 —— 那里一旦算「按字」，上下拖就变成加选，右上角计数自己往上涨，
    // 屏上却像是没选中任何东西。留白起手 → 滚动，正是他要的。
    app.hitChipText = function(lx, ly) {
      var info = this.selectPanelInfo;
      if (!info || !info.layout) return false;
      var L = info.layout;
      if (lx < 0 || ly < 0 || lx > info.w || ly > info.h) return false;
      var vTop = L.bodyTop || 0;
      var vBot = vTop + (L.viewH || 0);
      if (ly < vTop || ly > vBot) return false;
      var sy = (info.getScroll ? info.getScroll() : 0);
      var yy = ly + sy;
      var chs = L.chips || [];
      var HPAD = dp(3);
      var VINSET = dp(2);
      for (var i = 0; i < chs.length; i++) {
        var c = chs[i];
        if (yy < c.y + VINSET || yy > c.y + c.h - VINSET) continue;
        var twc = (c.tw !== undefined) ? c.tw : (c.w - dp(14));
        if (!(twc > 0)) twc = c.w;
        var tx0 = c.x + (c.w - twc) / 2;
        if (lx >= tx0 - HPAD && lx <= tx0 + twc + HPAD) return true;
      }
      return false;
    };

    // useRaw=true 时用屏幕坐标（箭头窗带自己的窗口偏移，必须传 true）
    app.handleSelectPanelTouch = function(ev, useRaw) {
      var info = this.selectPanelInfo;
      if (!info) return false;
      var act = 0;
      try { act = (ev.getActionMasked ? ev.getActionMasked() : ev.getAction()); } catch(eA2) { act = 0; }
      var lx = 0;
      var ly = 0;
      try {
        if (useRaw) {
          lx = ev.getRawX() - info.root.getLeft();
          ly = ev.getRawY() - info.root.getTop();
        } else {
          lx = ev.getX() - info.root.getLeft();
          ly = ev.getY() - info.root.getTop();
        }
      } catch(eP) {
        return true;
      }

      // ===== V7.39：按下 → 拖动 → 抬起 三段式，支持拖动框选 =====
      // 之前只在抬手时判定，手指在面板上划过去一个事件都收不到。
      // V7.45：按下的那一瞬间就把这次手势分好类 —— 按在字上是「选字」，
      // 按在卡片空白是「滚动」；按在字上是选字，再按已选数量分加选 / 反选。
      if (act === 0) {                       // ACTION_DOWN
        info.drag = null;
        var hitD = this.hitSelectPanel(lx, ly);
        var isChipD = (hitD.indexOf("chip:") === 0);
        // 只有卡片内空白（"inside"）才算滚动起手；按钮、卡片外都不建手势。
        // V7.56：还必须是**文字区内部**的空白。缩略图、缩略图两侧的留白、
        // 分割线附近都算"inside"，但它们不是文字区 —— 在那些地方上下拖，
        // 用户的意思是"看这张图"，不该把上面的文字滚走。
        var Ldn = info.layout || {};
        var vTopD = Ldn.bodyTop || 0;
        var vBotD = vTopD + (Ldn.viewH || 0);
        var isBlankD = (hitD === "inside" && ly >= vTopD && ly <= vBotD);
        // V7.49：命中块但离字太远（块内留白）→ 起手算空白，上下拖即滚动。
        // 点选不受影响：抬手仍走 hitSelectPanel 的宽松命中，点偏一点也能选中。
        if (isChipD && !this.hitChipText(lx, ly)) {
          isChipD = false;
          isBlankD = true;
          probeLog("PANEL_DOWN_BLANK_IN_CHIP " + hitD);
        }
        if (isChipD || isBlankD) {
          var giD = isChipD ? Number(hitD.substring(5)) : -1;
          var selN = 0;
          for (var sq = 0; sq < info.selected.length; sq++) if (info.selected[sq]) selN++;
          // 反选判据：已选 ≥2 块，且按下的这块本身也选着 → 这一拖是把
          // 扫过的这一段**取消**。只选 1 个（刚点下的锚点）时仍是加选，
          // 否则「点一个再往下拖」会把自己取消掉——这是真机会立刻发现的怪。
          info.drag = {
            gi: giD, x0: lx, y0: ly,
            fromChip: isChipD,
            toggle: (isChipD && selN >= 2 && !!info.selected[giD]),
            mode: "", scrollStart: 0, scrolled: 0,
            active: false, cur: {}, prev: {}
          };
          probeLog("PANEL_DRAG_DOWN gi=" + giD + " from=" + (isChipD ? "chip" : "blank") +
                   " sel=" + selN + " toggle=" + (info.drag.toggle ? 1 : 0));
        }
        return true;
      }
      if (act === 2) {                       // ACTION_MOVE
        var d = info.drag;
        if (!d) return true;
        var dx = lx - d.x0;
        var dy = ly - d.y0;
        if (!d.active) {
          // 几像素的抖动不算拖动，否则普通点击会被判成框选
          // V7.45：6dp → 10dp。点击容错更大；「点完往右带一下」10dp 就生效。
          var slop = dp(10);
          if (Math.abs(dx) < slop && Math.abs(dy) < slop) return true;
          d.active = true;
          if (!d.fromChip) {
            // 空白起手：垂直 → 滚动；水平 → 什么都不做（防误触）
            d.mode = (Math.abs(dy) >= Math.abs(dx)) ? "scroll" : "none";
            // 以"刚判定成滚动"这一刻的位置为基准：之前的 10dp 抖动不补跳，
            // 后面的位移再 1:1 跟手。
            d.scrollStart = info.getScroll();
          } else {
            d.mode = d.toggle ? "toggle" : "extend";
          }
          probeLog("PANEL_DRAG_START gi=" + d.gi + " mode=" + d.mode +
                   " from=" + (d.fromChip ? "chip" : "blank"));
        }
        if (d.mode === "scroll") {
          // V7.46：1:1 跟手滚动 —— 手指上移 10px，内容就上移 10px（scrollY+10）。
          // 基准取 scrollStart，所以手指来回摆不会累加漂移，抬起即停（不做
          // 惯性：惯性要自己跑动画，每一步都得重画 4MB 位图，不值当）。
          // 只改滚动位置、不动 chips、不动选中态，所以重画很便宜。
          if (info.scrollTo(d.scrollStart + (d.y0 - ly))) {
            d.scrolled = info.getScroll() - d.scrollStart;
          }
          return true;
        }
        if (d.mode === "none") return true;
        this.applyPanelDrag(info, d, lx, ly);
        return true;
      }
      if (act === 3) {                       // ACTION_CANCEL
        info.drag = null;
        return true;
      }
      if (act !== 1) return true;            // 只处理抬手

      var drag = info.drag;
      info.drag = null;
      // 拖动结束：抬手只收尾。起点块在拖动过程中已按区间结果置位，
      // 这里再 toggle 一次会把它翻回原样。滚动手势也走这条，
      // 绝不能在抬手时又落到某个字上点一下。
      if (drag && drag.active) {
        probeLog("PANEL_DRAG_END mode=" + drag.mode +
                 (drag.mode === "scroll" ? " scrolled=" + Math.round(info.getScroll()) : ""));
        return true;
      }

      var hit = this.hitSelectPanel(lx, ly);
      try { probeLog("PANEL_HIT " + hit + " @" + Math.round(lx) + "," + Math.round(ly)); } catch(eHl) {}
      if (hit === "outside") { try { this.cancelSelectPanel(); } catch(eOc) {} return true; }
      if (hit === "cancel") { try { this.cancelSelectPanel(); } catch(eCn2) {} return true; }
      // V7.37：切换单字/单词。只重画卡片，不关面板、不动窗口。
      if (hit === "mode") {
        try { info.toggleMode(); } catch(eMd) { probeLog("PANEL_MODE_FAIL " + String(eMd && eMd.message ? eMd.message : eMd)); }
        return true;
      }
      if (hit === "copy") {
        var out = joinPickSegments(info.text, info.segs, info.selected);
        if (!out) {
          // V7.43：原来会弹「请先选择文字」，现在静默——面板不关，用户
          // 继续点选即可。留一行 probe，排查"点复制没反应"时能区分。
          try { probeLog("PANEL_COPY_EMPTY"); } catch(eT2) {}
          return true;
        }
        try { this.confirmSelectPanel(out); } catch(eCp2) {}
        return true;
      }
      if (hit === "save") {
        // V7.55：只要图。不带 pickedText —— 导入侧「截图/仅存图」那条
        // 分支就是"存图不写剪贴板"，正好是这里要的。
        try { this.confirmAreaAction("save"); } catch(eSv) {}
        return true;
      }
      if (hit === "share") {
        // V7.55：存图 + 拉起系统分享。导入侧多一条「截图/分享」分支。
        try { this.confirmAreaAction("share"); } catch(eSh) {}
        return true;
      }
      if (hit === "clear") {
        // V7.39：单字模式也支持全选（多选），按钮在「清空 / 全选」之间换字
        var any = false;
        for (var i = 0; i < info.selected.length; i++) if (info.selected[i]) { any = true; break; }
        for (var j = 0; j < info.selected.length; j++) info.selected[j] = !any;
        try { info.redraw(); } catch(eRd) {}
        return true;
      }
      if (hit.indexOf("chip:") === 0) {
        var idx = Number(hit.substring(5));
        if (idx >= 0 && idx < info.selected.length) {
          // V7.39：两种模式都是多选 —— 点一下切换这一个块
          info.selected[idx] = !info.selected[idx];
          try { info.redraw(); } catch(eRd2) {}
        }
        return true;
      }
      return true;
    };

    // V7.39：拖选时的"当前落在哪个块"。
    // 先按 y 找行（落在行间空隙就取最近的一行），再在行内按 x 找最近的块 ——
    // 所以手指拖到某一行末尾的空白处，也会算在那一行的最后一个块上，
    // 不会因为"没正好压在字上"就断掉。
    app.panelDragIndexAt = function(info, lx, ly) {
      var L = info && info.layout;
      var chs = (L && L.chips) || [];
      var rows = (L && L.rowList) || [];
      if (!chs.length || !rows.length) return -1;
      // V7.46：ly 是屏幕坐标，chips 是内容坐标 —— 先加滚动偏移再比。
      var yy = ly + (info.getScroll ? info.getScroll() : 0);
      // V7.51：行表在布局期就排好了，这里只二分，不再每次 MOVE 重建数组。
      // 取"最后一个 top <= yy"的行，落在行间缝隙时再和下一行比距离。
      var lo = 0;
      var hi = rows.length - 1;
      var idx = 0;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (rows[mid].y <= yy) { idx = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (idx + 1 < rows.length) {
        var rA = rows[idx];
        var rB = rows[idx + 1];
        var dA = (yy < rA.y) ? (rA.y - yy) : ((yy > rA.y + rA.h) ? (yy - rA.y - rA.h) : 0);
        var dB = (yy < rB.y) ? (rB.y - yy) : ((yy > rB.y + rB.h) ? (yy - rB.y - rB.h) : 0);
        if (dB < dA) idx = idx + 1;
      }
      var row = rows[idx];
      // 行内取最近的块（落在一行末尾的空白处也算这一行最后一块，
      // 拖选不会因为"没正好压在字上"就断掉）
      var pick = row.s;
      var bd = 1e9;
      for (var m = row.s; m < row.e; m++) {
        var c2 = chs[m];
        if (lx >= c2.x && lx <= c2.x + c2.w) { pick = m; bd = 0; break; }
        var d2 = (lx < c2.x) ? (c2.x - lx) : (lx - (c2.x + c2.w));
        if (d2 < bd) { bd = d2; pick = m; }
      }
      // 返回**全局块索引**：chips 下标不保证等于 gi，混用会把区间算到别处
      var gpick = chs[pick].gi;
      return (gpick === undefined) ? pick : gpick;
    };

    app.applyPanelDrag = function(info, d, lx, ly) {
      // 空白起手的滚动手势 gi=-1，永远不该走到这里；真走到了直接忽略。
      if (d.gi < 0) return;
      // V7.46：拖到文字区的上/下边缘时跟着滚 —— 否则一屏以外的字永远选不到。
      // 越界越远滚得越快（上限 24dp/次），停在边缘不动就不再滚。
      var L2 = info.layout || {};
      var vTop = L2.bodyTop || 0;
      var vBot = vTop + (L2.viewH || 0);
      var edge = dp(28);
      var over = 0;
      if (ly > vBot - edge) over = Math.min(dp(24), ly - (vBot - edge));
      else if (ly < vTop + edge) over = -Math.min(dp(24), (vTop + edge) - ly);
      if (over !== 0) {
        if (info.scrollBy(over)) {
          // V7.51：整个手势只记一条。原来每个 MOVE 写一次盘（open/write/
          // close 全在主线程），边缘拖选时就是靠这个把帧拖没的。
          if (!d.edgeN) {
            d.edgeN = 1;
            probeLog("PANEL_EDGE_SCROLL start @" + Math.round(info.getScroll()));
          } else {
            d.edgeN++;
          }
        }
      }
      var cur = this.panelDragIndexAt(info, lx, ly);
      if (cur < 0) return;
      var a = Math.min(d.gi, cur);
      var b = Math.max(d.gi, cur);
      var toggle = (d.mode === "toggle");
      var changed = false;
      // 1) 上次在区间里、这次不在的，恢复原值
      for (var k in d.prev) {
        var ik = Number(k);
        if (ik < a || ik > b) {
          if (info.selected[ik] !== d.prev[k]) { info.selected[ik] = d.prev[k]; changed = true; }
        }
      }
      // 2) 区间内：加选置 true；反选取反快照值
      for (var g = a; g <= b; g++) {
        if (g < 0 || g >= info.selected.length) continue;
        if (d.prev[g] === undefined) d.prev[g] = !!info.selected[g];
        var want = toggle ? (!d.prev[g]) : true;
        if (info.selected[g] !== want) { info.selected[g] = want; changed = true; }
      }
      d.cur = { a: a, b: b };
      // V7.51：120ms → 60ms。单帧降下来后，选字跟手度可以再提一档。
      if (changed) info.requestRedraw(60);
    };

    // 真正摘除面板视图（不做状态判断，可安全重复调用）
    app.detachSelectPanel = function(info) {
      if (!info) return;
      info.drag = null;
      // 置位后 requestRedraw 不再排队：面板都摘了，别再画位图
      info._rdPending = true;
      try { if (info.root) info.root.setOnClickListener(null); } catch(eC) {}
      // 只是把子 View 从宿主 ViewGroup 上摘下来 —— 进程内操作，没有窗口
      // 事务、没有 InputChannel 销毁，所以不需要延后。
      try { if (info.host && info.root) info.host.removeView(info.root); } catch(e1) {}
      // 位图延后回收，理由见 info.redraw 里的说明。
      // V7.47：池里另一张也要一起还 —— 面板都摘了，留着就是白占 4MB。
      var bmpOld = info.bmp;
      var bmpPool = info._pool;
      info._pool = null;
      info._poolReady = false;
      info._poolSig = null;
      var hh = this.handler;
      var drop = function(b) {
        if (!b) return;
        try {
          hh.postDelayed(new java.lang.Runnable({ run: function() {
            try { b.recycle(); } catch(eBm) {}
          }}), 3000);
        } catch(eBm2) {}
      };
      if (hh) {
        drop(bmpOld);
        if (bmpPool && bmpPool !== bmpOld) drop(bmpPool);
      }
      try { if (info.root) info.root.removeAllViews(); } catch(eRa) {}
      info.host = null;
      info.root = null;
    };

    app.removeSelectPanel = function() {
      var info = this.selectPanelInfo;
      this.selectPanelInfo = null;
      cancelPanelHold();            // V7.48：面板撤了，停留看护也撤
      if (!info) return;
      this.detachSelectPanel(info);
    };

    // 确认/取消同样发生在输入事件回调里，所以拆面板 + 关会话要 post 到
    // 下一轮消息循环再执行（32ms 足够离开本次触摸派发）。
    app.confirmSelectPanel = function(value) {
      var info = this.selectPanelInfo;
      if (!info) return false;
      this.selectPanelInfo = null;               // 先占位，防连点
      cancelPanelHold();                         // V7.48：用户已做决定，撤看护
      var pp = this.pendingPick || {};
      this.pendingPick = null;
      var out = String(value || "");
      var self = this;
      // V7.35：截图模式下面板只是「挑字」的中间站，确认后要把截图一起交付
      // （area_capture + pickedText），不能走取字的 text_pick。
      var isArea = (this.panelKind === "area");
      this.panelKind = "text";
      probeLog("PANEL_CONFIRM len=" + out.length + " kind=" + (isArea ? "area" : "text"));
      try {
        this.handler.postDelayed(new java.lang.Runnable({ run: function() {
          try { self.detachSelectPanel(info); } catch(e1) {}
          try {
            if (isArea) self.finishAreaResult(out);
            else self.deliverTextDirect(out, pp.hp, pp.rect);
          } catch(e2) {}
        }}), 32);
      } catch(ePost) {
        try { this.detachSelectPanel(info); } catch(e3) {}
        if (isArea) return this.finishAreaResult(out);
        return this.deliverTextDirect(out, pp.hp, pp.rect);
      }
      return true;
    };

    // V7.55：截图模式的「保存图片 / 分享」。和 confirmSelectPanel 的区别只有
    // 一点：不带选中文字（这两个按钮要的是图，不是字），改用 flags.action
    // 让导入侧分流。拆面板同样要 post 到下一轮消息循环。
    app.confirmAreaAction = function(action) {
      var info = this.selectPanelInfo;
      if (!info) return false;
      this.selectPanelInfo = null;               // 先占位，防连点
      cancelPanelHold();
      this.pendingPick = null;
      this.panelKind = "text";
      var self = this;
      var act = String(action || "save");
      probeLog("PANEL_AREA_ACTION " + act);
      // V7.62：点下去立刻给反馈。落盘、关面板、startActivity 加起来虽然只有
      // 几十毫秒，但系统分享面板自己要 resolve 全部能收 image/png 的 app 并
      // 加载图标（冷启动能到 1s），这段时间屏幕上只有"面板消失了"。
      // V7.66：「正在分享中…」这条吐司移到导入侧指令链（「截图/分享」分支的
      // 第一条动作）。脚本不再持有任何 UI 通道。
      try {
        this.handler.postDelayed(new java.lang.Runnable({ run: function() {
          try { self.detachSelectPanel(info); } catch(e1) {}
          try { self.finishAreaResult("", { action: act }); } catch(e2) {}
        }}), 32);
      } catch(ePost) {
        try { self.detachSelectPanel(info); } catch(e3) {}
        return this.finishAreaResult("", { action: act });
      }
      return true;
    };

    app.cancelSelectPanel = function() {
      var info = this.selectPanelInfo;
      if (!info) return false;
      this.selectPanelInfo = null;
      cancelPanelHold();                         // V7.48：用户已做决定，撤看护
      this.pendingPick = null;
      var self = this;
      // V7.35：截图模式下「取消」= 不要文字，只要图。必须交付截图，
      // 不能走 finishCancel —— 否则用户框了半天什么也没拿到。
      // V7.36：交付时打 data.cancel=true，导入侧据此只存图、绝不写剪贴板。
      var isArea = (this.panelKind === "area");
      this.panelKind = "text";
      probeLog("PANEL_CANCEL kind=" + (isArea ? "area" : "text"));
      try {
        this.handler.postDelayed(new java.lang.Runnable({ run: function() {
          try { self.detachSelectPanel(info); } catch(e1) {}
          if (isArea) {
            try { self.finishAreaResult("", { canceled: true }); } catch(e2) {}
            return;
          }
          try { self.close(); } catch(e3) {}
          finishCancel("取消选择");
        }}), 32);
      } catch(ePost) {
        try { this.detachSelectPanel(info); } catch(e4) {}
        if (isArea) return this.finishAreaResult("", { canceled: true });
        try { this.close(); } catch(e5) {}
        finishCancel("取消选择");
      }
      return true;
    };

    app.extractCurrentText = function(force) {
      if (this.pickTriggered) return false;
      this.updateHotState(false);
      if (this.currentText && this.currentTextRect) {
        var picked = trimText(String(this.currentText));
        if (!picked || picked.length === 0) {
          if (force) finishError("text_pick", "NO_TEXT", "未识别到控件文本");
          return false;
        }
        this.pickTriggered = true;
        return this.finishTextPick(picked);
      }
      if (force) finishError("text_pick", "NO_TEXT", "未识别到控件文本");
      return false;
    };

    app.commitRecentPick = function() {
      var now = nowMs();
      if (this.lastValidPickText && this.lastValidPickRect && 
          (now - this.lastValidPickTime <= this.lastValidPickExpireMs)) {
        this.currentText = String(this.lastValidPickText);
        this.currentTextRect = this.lastValidPickRect;
        this.currentTextKey = this.lastValidPickKey;
        this.currentPickClassName = String(this.lastValidPickClassName || "");
        this.currentPickPackageName = String(this.lastValidPickPackageName || "");
        this.currentPickHitMode = this.lastValidPickHitMode === undefined || this.lastValidPickHitMode === null ? -1 : Number(this.lastValidPickHitMode);
        this.hot = true;
        return this.extractCurrentText(true);
      }
      if (this.currentText && this.currentTextRect) {
        return this.extractCurrentText(true);
      }
      return false;
    };

    // 同步查询 + 应用（主线程）：用于按下/松手/停止/构建等关键时机
    app.updateInspect = function(force) {
      if (this.areaModeActive) return;
      // 令所有在途的后台查询结果失效，避免覆盖本次同步结果
      this.querySeq++;
      var now = nowMs();
      var hp = this.hotspot();
      var movedEnough = Math.abs(hp.x - this.lastQueryX) > this.minLookupMove || Math.abs(hp.y - this.lastQueryY) > this.minLookupMove;
      if (!force && !movedEnough) return;
      if (!force && now - this.lastLookup < this.moveLookupInterval) return;
      this.lastLookup = now;
      this.lastQueryX = hp.x;
      this.lastQueryY = hp.y;
      var result = this.queryAt(hp.x, hp.y, !!force);
      this.applyInspectResult(result);
    };

    // 拖动窗口位置更新（V7.6：dragFrameInterval=0 立即入队）
    // - 同一批输入事件内的多个 MOVE 只应用最后一次位置（dragUpdatePosted 合并），
    //   布局调用量 ≈ 输入批数，与 8ms 版相同；
    // - 但应用时机从"最多等 8ms"变为"当前输入批处理完立即执行"，
    //   指针交给 WM 的位置始终是最新鲜的，跟手延迟约 0。
    app.schedulePointerMove = function(x, y) {
      if (this.closed || !this.pointer || !this.pointerLp) return;
      this.pendingPointerX = x;
      this.pendingPointerY = y;
      if (this.dragUpdatePosted) return;
      this.dragUpdatePosted = true;
      var self = this;
      this.handler.postDelayed(new java.lang.Runnable({ run: function() {
        self.dragUpdatePosted = false;
        if (self.closed || !self.pointer || !self.pointerLp) return;
        self.pointerLp.x = self.pendingPointerX;
        self.pointerLp.y = self.pendingPointerY;
        try { self.wm.updateViewLayout(self.pointer, self.pointerLp); } catch(e1) {}
      }}), this.dragFrameInterval);
    };

    app.scheduleInspect = function(force) {
      if (this.closed || this.areaModeActive) return;
      if (force) {
        this.inspectPosted = false;
        this.updateInspect(true);
        return;
      }
      var now = nowMs();
      if (now - this.lastInspectMove < this.inspectMoveInterval) return;
      var hp = this.hotspot();
      var movedEnough = Math.abs(hp.x - this.lastQueryX) > this.minLookupMove || Math.abs(hp.y - this.lastQueryY) > this.minLookupMove;
      if (!movedEnough) return;
      if (now - this.lastLookup < this.moveLookupInterval) return;
      this.lastInspectMove = now;
      this.lastLookup = now;
      this.lastQueryX = hp.x;
      this.lastQueryY = hp.y;
      if (this.inspectPosted) return;
      this.inspectPosted = true;
      var self = this;
      var done = new java.lang.Runnable({ run: function() { self.inspectPosted = false; } });
      if (this.bgEnabled && this.bgHandler) {
        // V7.0：后台线程查询，主线程应用结果；拖动期间主线程零阻塞
        this.lookupAtAsync(hp.x, hp.y, function(res) {
          done.run();
          self.applyInspectResult(res);
        });
      } else {
        this.handler.postDelayed(new java.lang.Runnable({ run: function() {
          done.run();
          if (self.closed) return;
          var res = null;
          try { res = self.queryAt(hp.x, hp.y, false); } catch(e) {}
          self.applyInspectResult(res);
        }}), 16);
      }
    };

    app.close = function() {
      if (this.closed) return;
      this.closed = true;
      probeLog("CLOSE_ENTER");
      // V7.53：整段 try/catch/finally。CLOSE_DONE 是自愈守卫判断"上次面板
      // 有没有收尾"的唯一凭据 —— 它缺一次，下一次运行就会被当成"上次崩了"，
      // 把整个面板功能（取字 + 截图）关掉一轮。所以收尾中途不管哪里抛异常，
      // CLOSE_DONE 都必须写、必须落盘。
      try {
        // V7.35：截图 OCR 在途 / 交付信息一并清掉（在途线程回来会被
        // areaOcrRunning=false 拦下，不会二次交付）
        this.pendingPick = null;
        var arcOrphan = this.areaResult;
        this.areaResult = null;
        // V7.56：走到这里还留着 areaResult，说明会话是异常中断的（正常路径
        // 已在 finishAreaResult 里交付并清空）。临时 png 没人要，删掉 ——
        // 「没按保存/分享就不留文件」不能只在温暖路径成立。
        try {
          if (arcOrphan && arcOrphan.path) {
            var fOr = new java.io.File(String(arcOrphan.path));
            if (fOr.exists()) fOr.delete();
          }
        } catch(eOr) {}
        this.areaOcrRunning = false;
        this.areaOcrTimer = null;
        // V7.54：计时基准一起清，免得下次会话拿上一轮的 0 点算差值
        this.areaT0 = 0;
        this.areaOcrDoneAt = 0;
        this.panelKind = "text";
        // 面板是监视窗的子 View，必须在拆监视窗之前先摘掉
        try { this.removeSelectPanel(); } catch(ePnl) {}
        // V7.55：缩略图。它没挂到任何 View 上（renderPanel 是 drawBitmap
        // 拷贝像素到面板位图上），所以这里 recycle 不会出现"画着画着图没了"。
        var tbRel = this.areaThumb;
        this.areaThumb = null;
        try { if (tbRel) tbRel.recycle(); } catch(eThR) {}
        // V7.21：清理 OCR 兜底状态（在途 OCR 线程回来后会被 closed 拦截）
        this.ocrBlocks = null;
        this.ocrBlocksAt = 0;
        this.ocrMissCount = 0;
        this.ocrRunning = false;
        this.a11yMissAt = 0; // V7.26：清理 a11y 未命中短记忆（会话结束即失效）
        this.a11yMissBase = 0; // V7.27：清理短记忆总寿命基准
        this.memoValidating = false; // V7.28：清理后台校验在途标志
        try { releasePointerActive(); } catch(eRpa) {}   // V7.33.4：释放单实例标志
        ShortXPointerActiveRef = null;
        if (this.areaIdleRunnable && this.handler) {
          try { this.handler.removeCallbacks(this.areaIdleRunnable); } catch(e) {}
        }
        this.areaIdleRunnable = null;
        try { if (this.areaCaptureRunnable && this.handler) this.handler.removeCallbacks(this.areaCaptureRunnable); } catch(eAreaCb) {}
        try { if (this.areaCaptureRunnable && this.bgHandler) this.bgHandler.removeCallbacks(this.areaCaptureRunnable); } catch(eAreaCbBg) {}
        this.areaCaptureRunnable = null;
        try { if (this.bgHandler && this.lookupTask) this.bgHandler.removeCallbacks(this.lookupTask); } catch(eBgTask) {}
        this.lookupTask = null;
        try { if (this.handler) this.handler.removeCallbacksAndMessages(null); } catch(eCb) {}
        try { if (this.pointer) this.pointer.animate().cancel(); } catch(e0) {}
        // V7.53：下面三个拆窗调用原来裸着，任一抛异常都会跳过 CLOSE_DONE
        try { this.removeAreaCancelCatcher(); } catch(eRac) {}
        // V7.18：拆除全屏触摸监视窗
        try { this.removePickWatcher(); } catch(eRpw) {}
        try { this.removePointerOverlayNow(); } catch(eRpo) {}
        try { if (this.pointer) this.pointer.setOnTouchListener(null); } catch(eTouch) {}
        try { if (this.pointer) this.wm.removeViewImmediate(this.pointer); } catch(e1) { try { if (this.pointer) this.wm.removeView(this.pointer); } catch(e2) {} }
        // V7.0：退出后台查询线程；保留 handler 引用，避免后台任务回发结果时竞态
        try { if (this.bgThread) this.bgThread.quitSafely(); } catch(eQuit) {}
        this.bgThread = null;
        this.bgHandler = null;
        this.pointer = null;
        this.pointerLp = null;
        this.paint = null;
        this.wm = null;
        pointerRuntime = null;
        PointerRuntimeRef = null;
      } catch(eCloseBody) {
        try { probeLog("CLOSE_THROW " + String(eCloseBody && eCloseBody.message ? eCloseBody.message : eCloseBody)); } catch(eCt) {}
      } finally {
        probeLog("CLOSE_DONE");
        // V7.51 起日志攒批，这里必须立刻落盘：收尾之后进程可能马上被回收，
        // 留在内存里就等于没写。
        try { probeFlush(); } catch(eCf) {}
      }
    };

    // V7.33.5：build 失败/超时后的强制拆除。
    // 与 close() 的区别：**不看 closed 早退**——失败路径可能已把 closed
    // 置位，但窗口还挂在 WindowManager 上（最要命的是全屏可触监视窗：
    // 它会把整机触摸吞掉，用户只能杀 ShortX 进程）。只按「窗口是否还
    // 挂着」清理，全部 try 包裹。
    app.abortBuild = function() {
      this.closed = true;   // 先阻止后续回调（onTouch/定时任务）再拆窗
      try { this.removePickWatcher(); } catch(eA1) {}
      try { this.removeAreaCancelCatcher(); } catch(eA2) {}
      try { this.removePointerOverlayNow(); } catch(eA3) {}
      try { if (this.handler) this.handler.removeCallbacksAndMessages(null); } catch(eA4) {}
      var wm0 = this.wm;
      var pt = this.pointer;
      this.pointer = null;
      this.pointerLp = null;
      if (pt) {
        try { pt.setOnTouchListener(null); } catch(eA5) {}
        try { if (wm0) wm0.removeViewImmediate(pt); } catch(eA6) {
          try { if (wm0) wm0.removeView(pt); } catch(eA7) {}
        }
      }
      try { if (this.bgThread) this.bgThread.quitSafely(); } catch(eA8) {}
      this.bgThread = null;
      this.bgHandler = null;
      pointerRuntime = null;
      PointerRuntimeRef = null;
    };

    // ===== 构建入口 =====
    app.build = function() {
      var self = this;
      pointerRuntime = this;
      PointerRuntimeRef = this;
      this.wm = context.getSystemService(android.content.Context.WINDOW_SERVICE);
      // V7.0：UiAutomation 仅在构建时初始化一次（原每次查询都 setServiceInfo，是卡顿主因之一）
      // V7.33.5：connect/setServiceInfo 移出主线程——
      // 开机后 a11y 服务首批绑定可达 0.5~3s，旧实现在 build 里同步执行，
      // 直接推迟箭头出现。改由首次查询（后台线程）经 queryAt 的 5s 重放
      // 完成（lastEnsureUi 初值 0，首查必触发）。
      try { this.uiAutomation = shortx.getUiAutomation(); } catch(eUi) { this.uiAutomation = null; }

      // ---- 获取导航栏高度 ----
      var navBarHeight = 0;
      try {
        var resourceId = context.getResources().getIdentifier("navigation_bar_height", "dimen", "android");
        if (resourceId > 0) {
          navBarHeight = context.getResources().getDimensionPixelSize(resourceId);
        }
      } catch(e) {}
      if (navBarHeight == 0) {
        // 备选：通过 Display 获取
        try {
          var display = this.wm.getDefaultDisplay();
          var realSize = new android.graphics.Point();
          var size = new android.graphics.Point();
          display.getRealSize(realSize);
          display.getSize(size);
          navBarHeight = realSize.y - size.y;
        } catch(e) {}
      }
      this.navigationBarHeight = navBarHeight;

      // V7.33.5：屏幕指标校验 + 三级回退链——开机
      // 阶段 ShortX 进程可早于显示就绪启动，DisplayMetrics 返回 0×0：
      // 旧代码直接采信 → 指针窗 0×0 / clamp 退化成点（窗口贴屏角），
      // 而看门狗只查 alpha/visibility → 箭头永不出现。回退链：
      // DisplayMetrics → getRealSize → getCurrentWindowMetrics(API30+)
      // → 保守默认 1080×2340。
      var srcDm = null, srcReal = null, srcCwm = null;
      try {
        var dm0 = context.getResources().getDisplayMetrics();
        srcDm = { w: Number(dm0.widthPixels), h: Number(dm0.heightPixels) };
      } catch(eDmB) {}
      if (!(srcDm && srcDm.w > 0 && srcDm.h > 0)) {
        try {
          var dispB = this.wm.getDefaultDisplay();
          var ptB = new android.graphics.Point();
          dispB.getRealSize(ptB);
          srcReal = { w: Number(ptB.x), h: Number(ptB.y) };
        } catch(eDispB) {}
      }
      if (!(srcDm && srcDm.w > 0 && srcDm.h > 0) &&
          !(srcReal && srcReal.w > 0 && srcReal.h > 0)) {
        try {
          var cwmB = this.wm.getCurrentWindowMetrics();
          var bbB = cwmB.getBounds();
          srcCwm = { w: Number(bbB.width()), h: Number(bbB.height()) };
        } catch(eCwmB) {}
      }
      var smB = sanitizeScreenMetrics(srcDm, srcReal, srcCwm);
      this.screenW = smB.w;
      this.screenH = smB.h;
      this.paint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
      // V7.13：投影色预算缓存（onDraw 每帧使用，避免每帧 new Integer）
      try { this.shadowJint = jint(0x40000000); } catch(eShadowJint) { this.shadowJint = null; }
      this.handler = new android.os.Handler(android.os.Looper.getMainLooper());
      // ===== V7.0：后台查询线程（拖动期间主线程零阻塞）=====
      try {
        this.bgThread = new android.os.HandlerThread("ShortXPointerLookup");
        this.bgThread.start();
        this.bgHandler = new android.os.Handler(this.bgThread.getLooper());
      } catch(eBg) {
        this.bgThread = null;
        this.bgHandler = null;
        this.bgEnabled = false;
      }
      this.pointer = createPointerView(this);

      // ===== 增加 FLAG_LAYOUT_NO_LIMITS =====
      // V7.18：移除 V7.17 加的 FLAG_WATCH_OUTSIDE_TOUCH——ACTION_OUTSIDE
      // 要求同时设置 FLAG_NOT_TOUCH_MODAL 才会下发（本窗带 FLAG_NOT_FOCUSABLE、
      // 按分发规则不是 touch-modal 窗，只收得到箭头区域内的触摸），而
      // FLAG_NOT_TOUCH_MODAL 不能加（会改变本窗的触摸模态性）。窗外多指
      // 的检测改由 build() 里先添加的全屏监视窗 pickWatcher 负责；本窗
      // 只负责箭头区域内的多指，见 onTouch 顶部的检测块。
      this.pointerLp = new android.view.WindowManager.LayoutParams(
          this.pointerW, this.pointerH,
          android.view.WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
          android.view.WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE |
          android.view.WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN |
          android.view.WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
          android.graphics.PixelFormat.TRANSLUCENT
      );
      this.pointerLp.gravity = android.view.Gravity.TOP | android.view.Gravity.START;
      this.pointerLp.x = clampPointerX(this, Math.round(this.screenW / 2 - this.pickLocalX));
      this.pointerLp.y = clampPointerY(this, Math.round(this.screenH / 2 - this.pickLocalY));

      // --- 触摸监听器 ---
      this.pointer.setOnTouchListener(new JavaAdapter(android.view.View.OnTouchListener, {
        onTouch: function(v, ev) {
          // V7.63：这里是 JavaAdapter 回调，异常一旦漏出去就会穿过
          // InputDispatcher 直达 system_server —— V7.62 那个 nowMs 的
          // ReferenceError 就是这么把整机送进软重启的。整段包一层，
          // 任何异常只写日志、把事件吃掉，绝不外抛。
          try {
          var action = ev.getActionMasked();
          var rx = Math.round(ev.getRawX());
          var ry = Math.round(ev.getRawY());

          // V7.34：面板打开时，箭头窗（已透明但仍是本会话最上层的窗口）
          // 会挡住它那一小块。落在这里的点击必须按面板命中处理，否则用户
          // 会觉得"某个词块点了没反应"。用 raw 坐标（=屏幕坐标）换算。
          try {
            if (self.selectPanelInfo) {
              self.handleSelectPanelTouch(ev, true);
              return true;
            }
          } catch(ePT) {}

          // ===== V7.18/V7.19：取字态多指退出（箭头窗内部分）=====
          // 本窗只有 60×84dp，只接得到落在箭头/握点上的触摸；屏幕上其余
          // 位置的多指由 build() 里先添加的全屏监视窗 pickWatcher 接应，
          // 两窗共用 checkMultiTouchExit 的四信号检测（详见其定义处）。
          // 框选态下不启用：那边第二根手指的既有行为是取消框选返回取字，
          // 由全屏捕获窗负责，保持不变。命中后完全退出指针会话。
          if (!self.areaModeActive && !self.closed) {
            try {
              if (self.checkMultiTouchExit(ev)) {
                try { self.exitByMultiTouch(); } catch(eMultiExit) {}
                return true;
              }
            } catch(eMultiCheck) {}
          }

          if (action === android.view.MotionEvent.ACTION_DOWN) {
            // V7.11.1：按下即自愈——万一箭头因 ROM 动画异常处于透明 / 隐藏态，
            // 用户第一次触摸（操作本身完全正常）立即强制恢复可见
            try {
              self.pointer.setAlpha(1);
              self.pointer.setScaleX(1);
              self.pointer.setScaleY(1);
              self.pointer.setVisibility(android.view.View.VISIBLE);
              self.pointer.invalidate();
            } catch(eHeal) {}
            // 指针跳转：把窗口跳转到「手指左上方」，使箭头尖端（=取字点）出现在
            // 手指左上方、整支箭头避开指尖。看到的尖端就是取字点，瞄准直观。
            // 目标：尖端屏幕位置 = 手指(raw) - arrowOffset。raw 坐标即屏幕坐标，
            // 窗口新位置 lp' = 目标尖端 - pickLocal - screenOffset。
            // screenOffset（lp 坐标与真实屏幕坐标的恒定差）用本次触摸反推：
            //   窗口真实屏幕位置 = rx - ev.getX()，故 screenOffset = rx - ev.getX() - lp.x
            // 本窗口为 FLAG_LAYOUT_IN_SCREEN 全屏悬浮窗，该偏移恒为 0；反推值加
            // 上下限保护后仅作兜底自校正，不再调用 getLocationOnScreen——个别机型
            // 在窗口未布局时该 API 返回 (0,0)，直接采信会把箭头跳到反方向。
            var touchLocalX = 0, touchLocalY = 0;
            try {
              touchLocalX = Number(ev.getX()); if (isNaN(touchLocalX)) touchLocalX = 0;
              touchLocalY = Number(ev.getY()); if (isNaN(touchLocalY)) touchLocalY = 0;
            } catch(eLoc) {}
            var calX = clamp((rx - touchLocalX) - self.pointerLp.x, -200, 200);
            var calY = clamp((ry - touchLocalY) - self.pointerLp.y, -400, 400);
            self.dragCalX = calX;
            self.dragCalY = calY;
            // V7.13：DOWN 前惰性刷新屏幕尺寸（旋转 / 分屏后基准才对）
            try { self.refreshScreenMetrics(false); } catch(eMetricsDown) {}
            // 有效偏移：接近右/下缘时平滑收缩，保证手指贴边时尖端也能贴边
            var offDown = self.effectiveOffset(rx, ry);
            var jumpX = clampPointerX(self, rx - offDown.x - self.pickLocalX - calX);
            var jumpY = clampPointerY(self, ry - offDown.y - self.pickLocalY - calY);
            // 与拖动一致：跳转后同样过一次边界钳制（四边平滑贴边）
            var jumpSnapped = self.applySnap(jumpX, jumpY);
            jumpX = jumpSnapped.x;
            jumpY = jumpSnapped.y;
            self.pointerLp.x = Math.round(jumpX);
            self.pointerLp.y = Math.round(jumpY);
            try { self.wm.updateViewLayout(self.pointer, self.pointerLp); } catch(eJump) {}
            // 兜底：部分机型/ROM 在手势进行中会延迟应用同步 updateViewLayout，
            // 这里向指针视图消息队列补投一次重放（仅当窗口位置尚未被拖动更新过
            // 才执行，避免覆盖更新的位置），保证下一帧前窗口已就位。
            try {
              var jumpXr = self.pointerLp.x, jumpYr = self.pointerLp.y;
              self.pointer.post(new java.lang.Runnable({ run: function() {
                try {
                  if (self.closed || !self.dragging) return;
                  if (self.pointerLp.x === jumpXr && self.pointerLp.y === jumpYr) {
                    self.wm.updateViewLayout(self.pointer, self.pointerLp);
                  }
                } catch(eReJump) {}
              }}));
            } catch(ePostJump) {}
            self.dragging = true;
            self.pendingPointerX = self.pointerLp.x;
            self.pendingPointerY = self.pointerLp.y;
            self.dragUpdatePosted = false;
            self.inspectPosted = false;
            try { self.pointer.invalidate(); } catch(e) {}

            if (self.areaModeActive && self.areaHasBeenDragged) {
              self.resetAreaIdleTimer();
            }

            self.currentText = "";
            self.currentTextRect = null;
            self.currentTextKey = "";
            self.currentPickClassName = "";
            self.currentPickPackageName = "";
            self.currentPickHitMode = -1;
            self.lastValidPickText = "";
            self.lastValidPickRect = null;
            self.lastValidPickKey = "";
            self.lastValidPickClassName = "";
            self.lastValidPickPackageName = "";
            self.lastValidPickHitMode = -1;
            self.lastValidPickTime = 0;
            self.pickTriggered = false;
            self.resetHoverDebounce(true);
            self.dragSession++;
            self.resetAreaState();
            self.startAreaHoldCandidate(self.dragSession);
            self.scheduleInspect(true);
            // V7.23：OCR 缓存保鲜（对齐 APP DOWN 时 maybeRefreshOcrInBackground）
            // ——缓存陈旧（>1.5s）且 a11y 本会话从未命中（V7.25 a11yEffective
            // 实效门控）时后台刷新，本次查询照常走缓存快路（V7.26 起短记忆
            // 热时 forceLean：OCR 优先、未命中再走活动窗口 DFS），刷新完成按
            // 当前位置自动校正出框；缓存新鲜或 a11y 已实证有效则不动作
            try { self.maybeRefreshOcrInBackground(); } catch(eRefreshDown) {}
            return true;
          }

          if (action === android.view.MotionEvent.ACTION_MOVE) {
            // V7.13：MOVE 惰性刷新屏幕尺寸（函数内 2 秒节流，高频 MOVE 无忧）
            try { self.refreshScreenMetrics(false); } catch(eMetricsMove) {}
            // 窗口位置由手指反推：尖端 = 手指 - 有效偏移（V7.5 边缘感知：
            // 接近右/下缘时偏移 smoothstep 平滑收缩，尖端平滑到达并贴住边缘；
            // 远离边缘时偏移恒定，与 startX + dx 完全等价）；
            // 扣除 DOWN 时测得的屏幕偏移校准，与跳转基准保持一致
            var offMove = self.effectiveOffset(rx, ry);
            var nextX = rx - offMove.x - self.pickLocalX - self.dragCalX;
            var nextY = ry - offMove.y - self.pickLocalY - self.dragCalY;
            // ===== 应用边界钳制（V7.5：四边平滑贴边，无硬吸附瞬移）=====
            var snapped = self.applySnap(nextX, nextY);
            nextX = snapped.x;
            nextY = snapped.y;
            self.schedulePointerMove(nextX, nextY);

            if (self.areaModeActive) {
              // V7.77：比距离用平方，不开方 —— 每帧一次 Math.sqrt 在 Rhino
              // 解释器里是白花的钱，而这里只做「够不够大」的比较。
              var moveDx = nextX - self.lastStableMoveX;
              var moveDy = nextY - self.lastStableMoveY;
              var thMove = self.moveStableThreshold;
              if (moveDx * moveDx + moveDy * moveDy > thMove * thMove) {
                self.lastStableMoveX = nextX;
                self.lastStableMoveY = nextY;
                if (!self.areaHasBeenDragged) {
                  self.areaHasBeenDragged = true;
                }
                self.resetAreaIdleTimer();
              }
              // V7.77：原来调 hotspotFromPointerXY() 拿一个 {x,y} 临时对象，
              // 这里就地算成两个数 —— 拖动每秒上百次 MOVE，省的是 GC 抖动。
              self.areaEndX = Math.round(nextX + self.pickLocalX + self.screenOffsetX);
              self.areaEndY = Math.round(nextY + self.pickLocalY + self.screenOffsetY);
              self.showAreaFrame();
            } else {
              self.updateAreaHoldCandidate(nextX, nextY);
              self.scheduleInspect(false);
            }
            return true;
          }

          if (action === android.view.MotionEvent.ACTION_UP || action === android.view.MotionEvent.ACTION_CANCEL) {
            self.dragging = false;
            if (self.dragUpdatePosted) {
              self.dragUpdatePosted = false;
              self.pointerLp.x = self.pendingPointerX;
              self.pointerLp.y = self.pendingPointerY;
              try { self.wm.updateViewLayout(self.pointer, self.pointerLp); } catch(e) {}
            }
            try { self.pointer.invalidate(); } catch(e) {}

            if (self.areaModeActive) {
              if (action === android.view.MotionEvent.ACTION_CANCEL) {
                self.cancelAreaMode();
                self.close();
                finishCancel("框选取消");
              } else {
                var hpUp = self.hotspot();
                self.areaEndX = hpUp.x;
                self.areaEndY = hpUp.y;
                self.showAreaFrame();
                self.finishAreaCapture();
              }
              return true;
            }

            if (action === android.view.MotionEvent.ACTION_UP) {
              // V7.0：松手前按指针最终位置做一次同步查询，保证取字准确。
              // V7.26：该同步查询旧实现在云闪付类页面会 clearCache + 全树
              // 重拉 + 全窗口遍历，阻塞主线程 ~2s，「用户取消」反馈因此延迟
              // ——V7.26 加 forceLean（记忆热 + 缓存新鲜）仅覆盖记忆热场景，
              // 真机复测「指空白停留后松手」记忆已过期仍然落入冷路径。
              // V7.27：forceLean 放宽为「缓存新鲜即走」（不再要求记忆热）
              // ——OCR 快路 ~1ms，未命中走活动窗口 DFS 单路径，跳全窗口、
              // 不清缓存；缓存过期才回落完整路径。a11y 完好页面（微信）
              // MOVE 查询仍全路径优先（a11yHits 照涨，保鲜门控不回归），
              // 仅 UP 这一次走 lean。
              // V7.34：整段搬出输入回调。手指刚抬起时 InputDispatcher 还卡在
              // 这次 UP 的派发里等我们返回；旧实现却在同一调用栈里同步进 a11y
              // 服务遍历窗口树，而 a11y 遍历要拿 WMS 的窗口锁、WMS 又在等这次
              // 输入派发收尾 —— 三方互等，2 秒后 system_server 被看门狗带走，
              // 表现就是「松手卡住 → 软重启」。
              // 现在 onTouch 立即 return true，查询放到 80ms 后的消息里做。
              probeLog("UP_ENTER");
              if (self.upHandled) return true;
              self.upHandled = true;
              try {
                self.handler.postDelayed(new java.lang.Runnable({ run: function() {
                  probeLog("UP_RUN closed=" + (self.closed ? 1 : 0));
                  if (self.closed) return;
                  try { self.updateInspect(true); } catch(eUpLookup) {}
                  probeLog("UP_INSPECT_DONE");
                  var picked = false;
                  try { picked = self.commitRecentPick(); } catch(ePick) {}
                  probeLog(picked ? "UP_PICK_OK" : "UP_PICK_NONE");
                  if (!picked) {
                    try { self.close(); } catch(eCl) {}
                    finishCancel("用户取消");
                  }
                }}), Number(self.upInspectDelay) || 80);
              } catch(ePostUp) {
                // post 失败（Handler 已不可用等异常态）时**不**退回同步查询
                // ——同步查询正是这里要消灭的东西。直接按取消收尾。
                probeLog("UP_POST_FAIL " + String(ePostUp && ePostUp.message ? ePostUp.message : ePostUp));
                try { self.close(); } catch(eCl2) {}
                finishCancel("用户取消");
              }
            } else {
              self.close();
              finishCancel("用户取消");
            }
            return true;
          }
          return true;
          } catch(eTouchTop) {
            try { probeLog("TOUCH_FAIL " + safeString(eTouchTop)); } catch(eTF) {}
            return true;
          }
        }
      }));

      // V7.18：全屏触摸监视窗必须在指针窗之前添加——同类型 overlay
      // 窗口后来者居上，监视窗位于指针窗下层：箭头上的触摸仍归指针窗
      // （拖动/跳转/取字流程完全不变），屏幕上其余位置的触摸落进监视
      // 窗，与指针窗共同实现"取字态任意位置多指退出"（详见
      // showPickWatcher 上方的说明）。
      this.showPickWatcher();

      try { this.wm.addView(this.pointer, this.pointerLp); } catch(eAddPointer) {
        // V7.33.5：监视窗已挂上，必须先拆再抛——旧
        // 实现只置 closed 就抛，close() 因 closed 早退，全屏可触窗永久
        // 残留（整机触摸被吞，只能杀进程）。
        try { this.abortBuild(); } catch(eAbortAdd) {}
        throw eAddPointer;
      }
      try {
        // V7.27：首查异步化。原 scheduleInspect(true) 是主线程同步全路径
        // 查询——云闪付上一次 1~2s，箭头刚出现主线程就被堵住（真机「出现
        // 箭头后拖动还是慢」的组成之一）。改 false 走后台查询线程：主线程
        // 零阻塞，miss 结果照常置位短记忆（预热缓存在途时为 null，属预期）
        this.pointer.post(new java.lang.Runnable({ run: function() {
          try { self.getPointerLocationOnScreen(); self.scheduleInspect(false); } catch(ePostLocate) {}
        }}));
      } catch(ePostLocate2) {}
      // V7.11.1：可见性不再依赖入场动画——先同步置为完全可见（alpha=1），
      // 动画只剩 80ms 缩放微弹（即使动画卡住也无副作用，箭头始终可见）。
      // 修复个别 ROM 上 ViewPropertyAnimator 不推进导致箭头停在 alpha=0：
      // 表现为「抓得到、能取字、命中框正常、截图正常，唯独箭头不显示」。
      this.pointer.setAlpha(1);
      this.pointer.setScaleX(1);
      this.pointer.setScaleY(1);
      this.pointer.setVisibility(android.view.View.VISIBLE);
      try { this.pointer.invalidate(); } catch(eInv0) {}
      try {
        this.pointer.setScaleX(0.9);
        this.pointer.setScaleY(0.9);
        this.pointer.animate().scaleX(1).scaleY(1).setDuration(80).start();
      } catch(eEnterAnim) {
        try { this.pointer.setScaleX(1); this.pointer.setScaleY(1); } catch(eEnterFallback) {}
      }
      // V7.11.1：可见性看门狗——build 后 800ms / 2.5s 各检查一次，万一视图
      // 状态被 ROM 改坏（alpha / visibility / scale 异常）立即强制恢复并重绘
      var selfWatch = this;
      var watchRunnable = null;
      watchRunnable = new java.lang.Runnable({ run: function() {
        try {
          if (selfWatch.closed || !selfWatch.pointer) return;
          // V7.41：面板打开期间 alpha=0 是**故意**的（不然箭头压在卡片上挡字），
          // 截图落盘后等 OCR / 等面板的那几秒同理。这两种状态下绝不能"自愈"，
          // 否则用户会看到卡片上挂着一支箭头。只跳过，不改任何状态。
          // selectPanelDone 在 deliverText 里先占位（面板窗口还要 260ms 才建），
          // 用它可以覆盖"已决定弹面板、但卡片还没挂上去"的这段空档。
          if (selfWatch.selectPanelInfo || selfWatch.selectPanelDone) {
            probeLog("ARROW_HEAL_SKIP reason=panel");
            return;
          }
          if (selfWatch.areaResult) {
            probeLog("ARROW_HEAL_SKIP reason=area");
            return;
          }
          var pv = selfWatch.pointer;
          var needFix = false;
          try {
            needFix = (Number(pv.getAlpha()) < 0.999) ||
                      (Number(pv.getVisibility()) !== 0) ||
                      (Number(pv.getScaleX()) < 0.999) ||
                      (Number(pv.getScaleY()) < 0.999);
          } catch(eChk) { needFix = true; }
          if (needFix) {
            try {
              pv.setAlpha(1);
              pv.setScaleX(1);
              pv.setScaleY(1);
              pv.setVisibility(android.view.View.VISIBLE);
              pv.invalidate();
            } catch(eFix) {}
          }
        } catch(eWatch) {}
      }});
      try { this.handler.postDelayed(watchRunnable, 800); } catch(eW1) {}
      try { this.handler.postDelayed(watchRunnable, 2500); } catch(eW2) {}
      // V7.23：OCR 预热（对齐 APP startPrewarmIfNeeded）——指针窗已添加并
      // 置为可见，延迟 ocrPrewarmDelay(300ms) 后启动：无条件后台截图+OCR
      // 预热（V7.25 起移除 a11y 探测门控，根因见 startOcrPrewarm 头注；
      // 与用户瞄准时间重叠），完成弹「识别已就绪」。指针立即可见可交互
      // 不受影响（预热内部即 runOcrFallback，截图+OCR 在独立 daemon 线程）。
      var selfPrewarm = this;
      // V7.33.8：开机 2 分钟内把 OCR 预热推后到 1.2s
      // ——刚重启时系统在忙（服务拉起、应用冷启），立刻跑全屏截图 + 4 线程
      // OCR 会明显拖慢整机，也让「启动中…」显得很久。等系统缓一拍再跑。
      var prewarmDelay = this.ocrPrewarmDelay;
      try {
        var bootMs = pointerElapsedNow();
        if (bootMs > 0 && bootMs < 120000) prewarmDelay = 1200;
      } catch(eBootDelay) {}
      // V7.33.10：两段式预热——到点先看 a11y 是否已
      // 实证可用：可用（a11yHits>0）则再等 3.5s，多数取字会话此时已结束，
      // 7s 级的截图+OCR 根本不必跑；不可用（自绘/Canvas 页面）立即预热，
      // 不牺牲首查速度。
      try {
        this.handler.postDelayed(new java.lang.Runnable({ run: function() {
          try {
            if (selfPrewarm.closed) return;
            var extraDelay = selfPrewarm.nextPrewarmPlan(selfPrewarm.a11yHits);
            if (extraDelay > 0) {
              var laterPrewarm = new java.lang.Runnable({ run: function() {
                try { if (!selfPrewarm.closed) selfPrewarm.startOcrPrewarm(); } catch(ePrewarmHook2) {}
              }});
              selfPrewarm.handler.postDelayed(laterPrewarm, extraDelay);
              return;
            }
            selfPrewarm.startOcrPrewarm();
          } catch(ePrewarmHook) {}
        }}), prewarmDelay);
      } catch(ePrewarmHookPost) {}
      // 启动去阻塞：首查已由 pointer.post 入队，此处不重复同步查询；
      // 后台查询自检延后到独立 daemon 线程——不能在主线程 await(2s)，
      // 也不能在 bgHandler 上「自 post 自等」（looper 被占，必等满超时
      // 误判）。自检只写 bgEnabled，跨线程安全。
      var selfStart = this;
      // V7.33.5：自检每进程只做一次——已验过的直接
      // 沿用结论，不再每次运行都烧 2~4 次全树查询（与首次拖动/预热抢资源）
      if (ShortXPointerBgState === 1) {
        this.bgEnabled = true;
      } else if (ShortXPointerBgState === 2) {
        this.bgEnabled = false;
      } else {
        try {
          var verifyThread = new java.lang.Thread(new java.lang.Runnable({ run: function() {
            try { if (!selfStart.closed) selfStart.verifyBgQuery(); } catch(eVerify) { selfStart.bgEnabled = false; }
          }}), "ShortXPointerBgVerify");
          try { verifyThread.setDaemon(true); } catch(eDaemon) {}
          verifyThread.start();
        } catch(ePostVerify) { this.bgEnabled = false; }
      }
      // V7.33.5：12s 超时后 build 仍可能在主线程跑完——
      // 此时脚本已按 START_FAILED 返回、无人收尾，窗口必须自拆（否则全屏
      // 监视窗留下吞触摸）。正常路径 PointerResult.done 恒为 false。
      if (PointerResult.done) {
        try { this.abortBuild(); } catch(eAbortLate) {}
        return true;
      }
      return true;
    };

    // V7.0：后台查询自检（主线程与后台线程各查一次，比较命中是否一致）
    app.verifyBgQuery = function() {
      if (!this.bgEnabled || !this.bgHandler) return;
      var self = this;
      var vhp = this.hotspot();
      var syncRes = null;
      try { syncRes = this.queryAt(vhp.x, vhp.y, false); } catch(eV1) {}
      var bgRes = null;
      var bgErr = null;
      var bgLatch = new java.util.concurrent.CountDownLatch(1);
      var vt = new java.lang.Runnable({ run: function() {
        try { bgRes = self.queryAt(vhp.x, vhp.y, false); } catch(eV2) { bgErr = eV2; }
        bgLatch.countDown();
      }});
      try {
        this.bgHandler.post(vt);
        bgLatch["await"](2000, java.util.concurrent.TimeUnit.MILLISECONDS);
      } catch(eV3) {}
      var syncHit = !!(syncRes && syncRes.info);
      var bgHit = !!(bgRes && bgRes.info);
      if (!bgErr && syncHit !== bgHit) {
        // 重试一次，排除屏幕瞬时变化造成的误判
        var syncRes2 = null;
        try { syncRes2 = this.queryAt(vhp.x, vhp.y, false); } catch(eV4) {}
        var bgRes2 = null;
        var bgErr2 = null;
        var bgLatch2 = new java.util.concurrent.CountDownLatch(1);
        var vt2 = new java.lang.Runnable({ run: function() {
          try { bgRes2 = self.queryAt(vhp.x, vhp.y, false); } catch(eV5) { bgErr2 = eV5; }
          bgLatch2.countDown();
        }});
        try {
          this.bgHandler.post(vt2);
          bgLatch2["await"](2000, java.util.concurrent.TimeUnit.MILLISECONDS);
        } catch(eV6) {}
        syncHit = !!(syncRes2 && syncRes2.info);
        bgHit = !!(bgRes2 && bgRes2.info);
        if (bgErr2) bgErr = bgErr2;
      }
      if (bgErr || syncHit !== bgHit) {
        this.bgEnabled = false;
      }
      // V7.33.5：结论落缓存，后续运行直接沿用
      ShortXPointerBgState = this.bgEnabled ? 1 : 2;
    };

    // V7.33.4：重复运行防护——前一会话未结束（手指
    // 未离开屏幕/会话未 close）时拒绝本次执行，杜绝双箭头。层 1：同
    // 作用域持久引用；层 2：私有目录标志文件（跨作用域兜底，stale
    // 300s 与看门狗同寿命）。任一拦截即弹「取字正在进行中」并返回
    // 所有 case 均不命中的结果（ok=true/type=already_running，指令链
    // 静默结束，对 SwitchCase 零副作用）。
    // V7.33.5：拒绝必须立刻收尾——旧实现只
    // return 字符串（调用处丢弃返回值），PointerResult.done 保持 false，
    // 外层 latch.await() 死等满 300s 看门狗才返回 GLOBAL_TIMEOUT：用户
    // 侧「无箭头 + 无反馈 + 指令链卡 5 分钟」。另：层 1 命中时标志文件
    // 属于在跑的会话，不能声明归属（否则尾部会误删）。
    var alreadyRunning = !!(ShortXPointerActiveRef && !ShortXPointerActiveRef.closed);
    if (!alreadyRunning) pointerClaimed = claimPointerActive();
    if (alreadyRunning || !pointerClaimed) {
      // V7.43：原本弹「取字正在进行中」，现在静默拒绝——箭头的存在本身就是反馈。
      try { probeLog("ALREADY_RUNNING rejected"); } catch(eRunT) {}
      try { if (GlobalWatchdog) { GlobalWatchdog.cancel(); GlobalWatchdog = null; } } catch(eWdRun) {}
      var runJson = '{"ok":true,"type":"already_running"}';
      PointerResult.done = true;
      PointerResult.json = runJson;
      try { PointerResult.latch.countDown(); } catch(eRunCd) {}
      return runJson;
    }
    ShortXPointerActiveRef = app;

    var ret = runOnMainSync(function() { app.build(); return true; }, 12000);
    try {
      // V7.43：原来启动成功会弹一条使用说明长 Toast，已删除（静默启动）。
      if (!(ret && ret.ok)) {
        finishError("error", "START_FAILED", "指针启动失败: " + String(ret ? ret.error : "timeout"));
      }
    } catch(eRet) {}
    }



    // V7.13：全局看门狗——任何路径忘记 finishWithJson 时，300 秒后强制收尾，
    // 杜绝 latch.await() 永久挂起（指针悬浮窗滞留 + ShortX 指令链卡死）。
    // 正常完成时 finishWithJson 会 cancel 本看门狗，不产生泄漏。
    // 时长按"足够慢的完整人工操作"取值：取字/框选/悬停都在数秒级，
    // 300 秒只可能命中真正的异常挂死；如确需更长会话可调大此值。
    try {
      GlobalWatchdog = new java.util.Timer("ShortXPointerGlobalWatchdog", true);
      GlobalWatchdog.schedule(new JavaAdapter(java.util.TimerTask, { run: function() {
        try {
          if (!PointerResult.done) {
            try {
              if (PointerRuntimeRef && PointerRuntimeRef.close) PointerRuntimeRef.close();
            } catch(eWdClose) {}
            finishError("pointer_error", "GLOBAL_TIMEOUT", "指针会话超时（300 秒无结果），已强制收尾");
          }
        } catch(eWd) {}
        try { if (GlobalWatchdog) { GlobalWatchdog.cancel(); GlobalWatchdog = null; } } catch(eWdC) {}
      }}), 300000);
    } catch(eWdInit) { GlobalWatchdog = null; }

    try {
      startPointerTextToPickword();
    } catch(eStart) {
      finishError("error", "START_EXCEPTION", "指针启动异常: " + safeString(eStart.message || eStart));
    }

    try {
      if (!PointerResult.done) {
        PointerResult.latch["await"]();
      }
    } catch(eWait) {
      finishError("error", "WAIT_INTERRUPTED", "等待指针结果中断: " + safeString(eWait.message || eWait));
    }

    // V7.33.4：统一释放单实例标志——覆盖全部收尾路径
    // （含 build 失败/启动异常等不经 app.close 的路径；幂等，close 内
    // 已释放时此处无操作）
    // V7.33.5：只释放自己占用的标志——拒绝路径
    // （pointerClaimed=false）不碰别人的会话，否则在跑的会话会失去层 1/
    // 层 2 保护，可能被第三次运行重入。
    if (pointerClaimed) {
      releasePointerActive();
      ShortXPointerActiveRef = null;
    }

    return PointerResult.json;
})();