// ============================================================
// 指针核心独立 JSON 版   V7.33.11 (指针核心同 V7.16)
// ShortX ExecuteJS 脚本：悬浮指针取字 / 框选截图，结果以 JSON 返回，
// 由导入文件的 SwitchCase 解析后决定后续动作。
// ============================================================
//
// 【运行链路】
//   入口 → 单实例防护（层1 内存引用 / 层2 标志文件 pid+开机批次）
//   → runOnMainSync(build, 12s)：建指针窗、框选捕获窗、全屏监视窗
//   → DOWN 定位 / MOVE 拖动（后台线程查询）/ UP 取字或出框
//   → finishWithJson（幂等）→ latch.countDown → 返回 JSON
//   兜底：300s 全局看门狗；build 失败或 12s 超时走 abortBuild 强制拆窗
//   （否则全屏监视窗留下会吞掉整机触摸）。
//
// 【查询模型】性能与正确性的核心
//   · a11y 优先：queryAt 先活动窗口 DFS，未命中再全窗口遍历；
//     本会话 a11y 命中过（a11yHits>0）的应用全程走 a11y，不被 OCR 覆盖
//     （否则桌面图标+两段文字会被 OCR 合并成一行）。
//   · OCR 只兜底 a11y 不可用的场景（云闪付、Canvas、游戏）。
//   · 短记忆三态：alive→OCR 快路（~1ms）；expired→快路 + 后台校验；
//     cold→完整路径。查询路径永不阻塞，慢路径一律挪到 daemon 线程。
//   · 拖动中查询跑独立线程（并发上限 2，位置更新即丢弃旧查询）。
//
// 【指针窗】
//   · 位置：尖端 = 手指 - effectiveOffset。右/下缘 smoothstep 收缩，
//     并在距边 53dp 内叠加边缘加速（每 1dp 位移多走 0.45dp，≈1.9×）。
//   · 可见性：800ms/2.5s 看门狗校正 alpha/visibility/scale；
//     另有 DOWN 自愈与监视窗首触召回（防 ROM 改坏视图状态）。
//   · 多指退出：由全屏监视窗 pickWatcher 四信号检测（跨 ROM，见
//     checkMultiTouchExit），箭头窗只负责自身区域。
//
// 【框选截图】
//   悬停 1.5s 进入（锚点 3dp 容差、到期 14dp 确认）→ 拖动选区 →
//   停止 1.5s 自动截图（120ms 让框稳定）；第二指取消；截图前把框选
//   框置 INVISIBLE、内缩 1dp，保证边缘内容不被裁掉。
//
// 【OCR】
//   · 预热按 a11y 实效决定：已命中→再等 3.5s（多数会话已结束），
//     未命中→立即（这些页面就靠 OCR）。
//   · 缓存：成功 30s；空结果按连续次数退避 8s→16s→30s。
//   · 聚合：视觉行聚类 → 行内按 12dp 间隙拆组 → 阅读序垂直合并成块
//     （判据详见 buildOcrBlocks 头注）。
//
// 【吐司】
//   三通道：ShowToast 动作 / 系统 Toast / 全局 showToast。主线程调
//   executeAction 会重入死锁（V7.24.1），故一律 daemon 线程弹；三通道
//   全挂时把码挂 data.toast，由 SwitchCase 兜底补弹。
//
// 【维护】
//   gen_v3311.py（锚点替换生成本文件）→ gen_import_v3311.py（导入文件：
//   head JSON + 分隔行 + da 动作尾，versionCode+1）→
//   verify_import_v3311.py（关键词回归）+ test_*.js（node vm 单测）。
//   改母版必须同步校验器与单测。
//
// ============================================================
// 版本沿革（细节见 V7.33.x_优化说明.md）
// V7.0       查询与 UI 更新分离：后台查询、主线程应用
// V7.5       边缘感知偏移：smoothstep 平滑收缩，消除速度突变
// V7.6       拖动帧合并：dragFrameInterval 0，同一输入批只布局一次
// V7.7       启动去阻塞：删重复首查，自检挪出主线程
// V7.10      框选截图模式（悬停进入、停止自动截图）
// V7.11      指针窗看门狗（alpha/visibility/scale 自愈）
// V7.13      全局看门狗 + 投影色缓存
// V7.16      指针核心定型
// V7.18      多指退出改全屏监视窗（WATCH_OUTSIDE_TOUCH 不生效）
// V7.20      修复部分界面取字完全失效
// V7.21      OCR 兜底通道（a11y 不可用页面）
// V7.22      修复慢移误触发框选
// V7.23      OCR 缓存/预热策略对齐 APP，块级聚合整段一框
// V7.24      OCR 提示全链路；V7.24.1 修执行器重入死锁；V7.24.2 修吐司
//            交替轰炸；V7.24.3 微信列表误并；V7.24.4 小红书标题乱序；
//            V7.24.5 启动反馈迟滞与空结果重跑卡顿
// V7.25      任意界面启动无反馈 + 云闪付黄框慢
// V7.26      就绪吐司丢失 + 云闪付慢半拍 / 取消延迟
// V7.27      短记忆顺延 + 独立线程查询 + 首查异步化
// V7.28      取消双弹 + 残留黄框（三态短记忆 + 后台校验）
// V7.29      后台校验用当前坐标 + apply 新鲜度守卫
// V7.30      酷安启动后黄框消失（a11y 实效优先）
// V7.31      OCR 内部截图用完即删，不再堆垃圾
// V7.32      死代码清理（9 函数 / 32 配置 / 16 写行）
// V7.33      聚合间隙改「一行字高」相对判据（自适应字号/密度）
// V7.33.1    吐司合并：ocr_done 移除，统一 ready 单码
// V7.33.2    a11y 全程优先：OCR 完成不再覆盖 a11y 拾取
// V7.33.3    「启动中…」会话内只弹一次
// V7.33.4    重复运行防护（前会话未结束则拒绝，防双箭头）
// V7.33.5    启动链路修复：拒绝立即收尾（不再卡 300s）/ 标志文件带 pid
//            与开机批次 / 指标三级回退 / abortBuild / 自检每进程一次 /
//            app 提到 IIFE 级
// V7.33.6    框选边缘磁吸（已由 V7.33.7 撤销，改连续加速）
// V7.33.7    边缘加速：距边 80dp 内约 2×（取字与框选共用）
// V7.33.8    加速收敛到 0.45（约 1.9×），开机预热让路 1.2s
// V7.33.9    诊断行落盘（已于 V7.33.11 下线）
// V7.33.10   预热按 a11y 实效让路 + OCR 线程降为后台优先级
// V7.33.11   加速区 80→53dp；下线分析与日志（bootTiming / data.diag /
//            诊断行）；删除 selfRect/hitRadius 死参数链路（每次查询省一次
//            new Rect + getLocationOnScreen）
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
    //     case 的 mv data/screenshots/* 搬进相册；
    //   stale：文件年龄 >300s（全局看门狗同寿命）视为上次异常残留，
    //     清除放行；全程 try/catch——IO 失败降级放行（防护失效但不
    //     阻塞正常使用）。
    var POINTER_ACTIVE_STALE_MS = 300000;
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
          var age = (new Date()).getTime() - f.lastModified();
          var rec = pointerFlagRecord(f);
          // 开机批次判定：elapsedRealtime 自本次开机起算，记录值若明显大于
          // 当前值，说明那是上一次开机的会话（重启过）→ 必为残留，立即清。
          // 旧实现只看文件年龄，重启后 300s 内的第一次运行会被误判为
          // 「上一会话仍在」而拒绝（随后又因拒绝不收尾而卡满 300s）。
          var rebooted = rec.elapsed > 0 && nowElapsed > 0 &&
                         rec.elapsed > nowElapsed + 1000;
          if (!rebooted && age < POINTER_ACTIVE_STALE_MS) {
            return false; // 前一会话仍在进行
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
    // V7.24：ShowToast proto 动作类加载。这是 ShortX 指令链 SwitchCase 里
    // ShowToast 动作的同款原生通道（proto: message 字段，builder setMessage）。
    // 用户要求的「使用 shortx 的 Switch Case 里面的功能」即指此通道：
    // 脚本内 shortx.executeAction(ShowToast) 直接弹，与 SwitchCase 命中
    // 后执行 ShowToast 动作走的是同一条执行器链路。
    var HAS_SHOW_TOAST_ACTION = false;
    try { importClass(Packages.tornaco.apps.shortx.core.proto.action.ShowToast); HAS_SHOW_TOAST_ACTION = true; } catch(eImpToast) {}

    // V7.24：Toast 三通道（按优先级，V7.23 裸调全局 showToast 在本 DA 环境
    // 未注入、静默失败，用户收不到任何提示——真机反馈后重做）：
    //   ① shortx.executeAction(ShowToast proto)——SwitchCase ShowToast 同款
    //      原生通道，成功即可靠送达；
    //   ② android.widget.Toast.makeText(context, ...)——本 DA 环境实证可用
    //      （历史脚本 V6.4 起启动提示一直走此链路，100% 成功）；
    //   ③ 裸全局 showToast——兜底。
    // 三条全失败才放弃（此时吐司码入队，由导入文件 SwitchCase 在会话结束
    // 时命中对应 case 补弹，用户取消同款机制）。
    // V7.24.1：本函数只允许在 daemon 线程执行（经 toastFeedbackAsync
    // 派发）——主线程调 shortx.executeAction 会与等待 latch 的执行器
    // 线程重入死锁，症状是整个 UI 卡死只能重启系统。
    var PendingToastCode = "";  // 原生通道失败时暂存的吐司码，finishWithJson 回传
    // 吐司文案码表（与导入文件 SwitchCase 新增 case 的 ShowToast 文案保持一致）
    var TOAST_TEXTS = {
      "starting": "启动中…",
      "ready": "识别已就绪",
      "running": "取字正在进行中",  // V7.33.4：重复运行防护反馈
      "cancel": "用户取消"   // V7.27：母版直弹（见 finishCancel），SwitchCase 取消
                            // case 增加 data.toast!=='cancel' 条件防双弹
    };
    function toastNative(msg) {
      var text = String(msg);
      // ① ShowToast proto 动作（SwitchCase 里 ShowToast 的同款通道）
      if (HAS_SHOW_TOAST_ACTION) {
        try {
          shortx.executeAction(ShowToast.newBuilder().setMessage(text).build());
          return true;
        } catch(eT1) {
          try {
            shortx.executeAction(ShowToast.newBuilder().setText(text).build());
            return true;
          } catch(eT2) {}
        }
      }
      // ② 系统 Toast（DA 环境实证可用）。V7.26 起 LENGTH_SHORT——
      // 反馈类吐司（启动中/识别已绪/OCR 识别完成）不需要长停留，
      // 缩短占位减少后续吐司（如「用户取消」）的排队延迟
      try {
        android.widget.Toast.makeText(context, text, android.widget.Toast.LENGTH_SHORT).show();
        return true;
      } catch(eT3) {}
      // ③ 全局 showToast 兜底
      try { showToast(text); return true; } catch(eT4) {}
      return false;
    }
    // 带码反馈：优先原生三通道即时弹；全部失败时，ready/cancel
    // 两个码存入 PendingToastCode（starting 不入队——会话结束再弹「启动中」
    // 毫无意义），由 finishWithJson 经 data.toast 回传脚本结果 JSON，
    // 导入文件 SwitchCase 在会话结束时命中对应 case 用 ShowToast 补弹。
    // V7.27：cancel 入队——「用户取消」改母版直弹后，仅三通道全挂时才需要
    // SwitchCase 兜底（取消 case 条件 data.toast!=='cancel' 保证不双弹）。
    // V7.24.1：本函数只允许在 daemon 线程执行——绝对不能在主线程调用
    // shortx.executeAction（死锁根因见文件头 V7.24.1 说明）。
    function toastFeedback(code) {
      var key = String(code || "");
      var text = TOAST_TEXTS[key] || key;
      if (toastNative(text)) return;
      // V7.28：cancel 入队优先——终端反馈，不被先前的 ready
      // 掩盖（否则 data.toast='ready' 会顶掉取消兜底码，用户收不到
      // 「用户取消」）；其余码先入队者保留
      if (key === "cancel" || (key === "ready" && !PendingToastCode)) {
        PendingToastCode = key;
      }
    }
    // V7.24.1：异步吐司反馈——起一次性 daemon 线程执行 toastFeedback。
    // 为什么必须异步：短X 执行器线程此刻正阻塞等待本脚本的
    // PointerResult.latch.countDown()（脚本没返回它就不能往下走）；
    // 若在主线程（=执行器线程）调 shortx.executeAction(ShowToast)，
    // 动作分发又需要执行器参与 → 重入死锁 → 脚本永不返回 → 指针悬浮
    // 窗与输入抓持不放 → 整个 UI 卡死，只能重启系统（真机复现）。
    // V7.21 的 executeAction(OcrDetect) 一直都在 daemon 线程调用且
    // 实证可用——本函数让吐司通道与 OCR 保持同款线程模型。daemon
    // 线程即使挂起也不影响系统 UI（最坏就是吐司不弹）。
    function toastFeedbackAsync(code) {
      var t = new java.lang.Thread(new java.lang.Runnable({ run: function() {
        try { toastFeedback(code); } catch(eTfa) {}
      }}), "ShortXPointerToast");
      try { t.setDaemon(true); } catch(eTfaDaemon) {}
      try { t.start(); } catch(eTfaStart) {}
    }

    // V7.28：同步吐司尝试——**只走不经 ShortX 执行器的通道**（② 系统
    // Toast、③ 全局 showToast），在主线程同步完成。专供 finishCancel
    // 的取消反馈。为什么不能复用 toastFeedbackAsync（fire-and-forget
    // daemon 线程）：
    //   a) 竞态——异步尝试尚未沉淀（PendingToastCode 未置位）时
    //      finishWithJson 已序列化 data.toast → 母版全挂时兜底码
    //      丢失 → SwitchCase 取消 case 不补弹（漏弹）；
    //   b) 死锁——若改 join 等待异步线程，daemon 线程内的
    //      executeAction（① proto 通道）需执行器（=主线程）参与，
    //      主线程却在 join 等待 → 双等死锁（V7.24.1 同源模型）。
    // 本函数只碰 ②/③（无执行器依赖；Toast 本应在主线程弹）；全挂才
    // 入队，由取消 case 兜底——① proto 通道与 SwitchCase 的 ShowToast
    // 同属执行器链路，经 data.toast==='cancel' 精确互补，不双弹。
    function toastFeedbackSync(code) {
      var key = String(code || "");
      var text = TOAST_TEXTS[key] || key;
      // ② 系统 Toast（DA 环境实证可用；LENGTH_SHORT 与 toastNative 一致）
      try {
        android.widget.Toast.makeText(context, text, android.widget.Toast.LENGTH_SHORT).show();
        return;
      } catch(eTs1) {}
      // ③ 全局 showToast 兜底
      try { showToast(text); return; } catch(eTs2) {}
      // 全失败：入队等 SwitchCase 兜底（cancel 优先，同 toastFeedback）
      if (key === "cancel" || (key === "ready" && !PendingToastCode)) {
        PendingToastCode = key;
      }
    }
    // V7.33.5：主线程吐司——拒绝路径运行在 ShortX
    // 执行器线程（无 Looper），直接调 Toast.show() 必抛
    // "Can't toast on a thread that has not called Looper.prepare()"，
    // 被 catch 吞掉后用户零反馈。此处 post 到主线程再走三通道。
    function toastFeedbackOnMain(code) {
      try {
        var h = new android.os.Handler(android.os.Looper.getMainLooper());
        h.post(new java.lang.Runnable({ run: function() {
          try { toastFeedbackSync(code); } catch(eTm) {}
        }}));
        return true;
      } catch(eTom) {
        try { toastFeedbackSync(code); return true; } catch(eTom2) { return false; }
      }
    }

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

      // V7.24：原生 Toast 三通道全部失败时，把待弹吐司码挂到 data.toast
      // 随结果 JSON 回传——导入文件 SwitchCase 在会话结束时命中对应 case
      // 用 ShowToast 补弹（用户取消同款机制）。码只在三通道全挂时才存在，
      // 正常路径下该字段不出现，对既有消费方零影响。
      try {
        if (!obj.data) obj.data = {};
        if (PendingToastCode && !obj.data.toast) obj.data.toast = PendingToastCode;
      } catch(eToastQ) {}

      PointerResult.json = safeJsonStringify(obj);
      try { PointerResult.latch.countDown(); } catch(e) {}
      // V7.13：正常收尾时取消全局看门狗，避免 Timer 泄漏
      try { if (GlobalWatchdog) { GlobalWatchdog.cancel(); GlobalWatchdog = null; } } catch(eWd) {}
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

    // V7.27：取消反馈母版直弹。旧实现「用户取消」只由导入文件 SwitchCase
    // 的取消 case 弹——该链路要等 ShortX 执行器线程从 latch 唤醒后提交
    // ShowToast 动作，延迟不可控（真机实测 UP 查询修快后仍要等）。现先经
    // toastFeedbackAsync 走母版三通道（系统 Toast 通道不经 ShortX 执行器，
    // 弹送即时）；三通道全挂时码入 PendingToastCode，随 data.toast 回传
    // 由取消 case 兜底（该 case 已加 data.toast!=='cancel' 条件防双弹）。
    // V7.28（真机复测反馈「用户取消出现了两次」后重做）：
    //   1) 幂等——done 后直接返回：UP/CANCEL/多指退出/close 多条路径
    //      可能先后到达，旧实现二次调用会再弹一次（母版直弹 + 兜底
    //      双通道下双弹概率更高）；
    //   2) 同步化——toastFeedbackAsync 的 fire-and-forget 与
    //      finishWithJson 的 data.toast 序列化竞态（尝试未沉淀即序列化
    //      → 母版全挂时兜底码丢失 → 漏弹），join 等待又与执行器模型
    //      死锁（V7.24.1）。改 toastFeedbackSync：主线程只走不经执行器
    //      的 ②/③ 通道，尝试同步完成，data.toast 与真实弹送一致；
    //   3) case 条件配套改正向——导入文件取消 case 仅在
    //      r.data.toast==='cancel'（母版全挂）时兜底（V7.27 的
    //      data.toast!=='cancel' 逻辑颠倒：母版成功反触兜底 → 双弹）。
    function finishCancel(message) {
      if (PointerResult.done) return; // V7.28：幂等守卫（杜绝双弹）
      try { toastFeedbackSync("cancel"); } catch(eFcToast) {}
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
      hitRadius: dp(0),
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
      screenW: 0,
      screenH: 0,
      hot: false,
      // ===== V7.21：OCR 兜底运行时状态 =====
      lastOcrTryAt: 0,         // 上次 OCR 尝试时间戳（冷却控制）
      ocrBlocks: null,         // 上次 OCR 解析出的文字块 [{left,top,right,bottom,text,confidence}]
      ocrBlocksAt: 0,          // OCR 结果时间戳（缓存有效期控制）
      ocrMissCount: 0,         // 连续 a11y 未命中计数
      ocrRunning: false,       // OCR 进行中（防重入）
      startingShown: false,    // V7.33.3：「启动中…」会话内只弹一次——预热
                               // 无条件首弹后，缓存过期再触发的用户路径 OCR
                               // 不再重复弹
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
      areaCaptureDelay: 120,

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
      var now = (new Date()).getTime();
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
              var nr = (new Date()).getTime();
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
        var now = (new Date()).getTime();
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
        this.lastValidPickTime = (new Date()).getTime();
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
      var now = (new Date()).getTime();
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
      if (!HAS_OCR_DETECT || !HAS_OCR_RECTSRC || !HAS_OCR_ANY) return; // 类加载失败则禁用
      if (this.ocrRunning) return;
      var now = (new Date()).getTime();
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
      if ((!background || prewarm) && !this.startingShown) {
        this.startingShown = true;
        toastFeedbackAsync("starting");
      }
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
        // mv <shortx>/data/screenshots/* 一并搬进相册 DCIM/Screenshots
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
          if (prewarm || (!background && blocks && blocks.length > 0)) {
            toastFeedbackAsync("ready");
          }
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
      var now = (new Date()).getTime();
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
      if (this.closed || this.areaModeActive) return;
      var now0 = (new Date()).getTime();
      if (this.ocrBlocks && now0 - this.ocrBlocksAt <= this.effectiveCacheTtl()) {
        this.ocrMissCount = 0;
        return;
      }
      this.ocrMissCount++;
      var now = (new Date()).getTime();
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
      if (this.closed || this.areaModeActive) return;
      if (!HAS_OCR_DETECT || !HAS_OCR_RECTSRC || !HAS_OCR_ANY) return;
      if (this.ocrRunning) return;
      if (!this.ocrBlocks) return;
      if (this.a11yEffective()) return; // a11y 已实证有效，无需 OCR 保鲜
      var now = (new Date()).getTime();
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
      if (state === 2) return makeStrokeBg(0x1822c55e, 0xff22c55e, 2, frameRadius);
      return makeStrokeBg(0x14f59e0b, 0xfff59e0b, 2, frameRadius);
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

    app.hideFrame = function() {
      var old = this.frame;
      this.frame = null;
      this.lastRectKey = "";
      this.lastFrameState = -1;
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
      if (this.areaIdleRunnable && this.handler) {
        try { this.handler.removeCallbacks(this.areaIdleRunnable); } catch(e) {}
      }
      var self = this;
      this.areaIdleRunnable = new java.lang.Runnable({ run: function() {
        if (self.areaModeActive && !self.closed && self.areaHasBeenDragged) {
          // 空闲超时退出：与"第二根手指取消"走同一条返回取字序列（无 Toast 反馈，保持原行为）
          self.returnToTextPickFromArea(null);
        }
      }});
      try { this.handler.postDelayed(this.areaIdleRunnable, this.areaIdleDelay); } catch(ePost) {}
    };

    // ---- 从框选态返回指针取字态（第二根手指取消 / 空闲超时共用）----
    // toastText 非空时给出 Toast 反馈；空闲超时传 null 保持静默
    app.returnToTextPickFromArea = function(toastText) {
      if (this.closed) return;
      var wasArea = this.areaModeActive;
      this.cancelAreaMode();
      this.resetHoverDebounce(true);
      this.currentText = "";
      this.currentTextRect = null;
      this.hot = false;
      this.hideFrame();
      this.scheduleInspect(true);
      if (wasArea && toastText) {
        try { android.widget.Toast.makeText(context, toastText, android.widget.Toast.LENGTH_SHORT).show(); } catch(eToast) {}
      }
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
            var rect = self.areaFrozenVisualRect ? self.areaFrozenVisualRect : self.getAreaVisualRect();
            if (!rect || rect.width < 1 || rect.height < 1) return;
            var p = self.paint;
            p.setAntiAlias(true);
            try { p.setShader(null); p.clearShadowLayer(); } catch(e0) {}
            p.setStyle(android.graphics.Paint.Style.STROKE);
            p.setStrokeWidth(dp(2));
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
      try {
        if (android.os.Build.VERSION.SDK_INT >= 16) this.areaFrame.postInvalidateOnAnimation();
        else this.areaFrame.invalidate();
      } catch(e1) {
        try { this.areaFrame.invalidate(); } catch(e2) {}
      }
    };

    app.removeAreaFrameNow = function() {
      var old = this.areaFrame;
      this.areaFrame = null;
      this.areaFrameLp = null;
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
    app.createPickWatcherView = function() {
      var WatcherView = JavaAdapter(android.view.View, {
        onDraw: function(canvas) {
          // 完全透明，仅用于接收触摸事件
        }
      }, context);
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
      this.returnToTextPickFromArea("已取消框选，返回取字");
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
      var out = new java.io.FileOutputStream(file);
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

    app.captureAreaToFile = function(rect, presetFile) {
      if (!rect || rect.width < this.areaMinSize || rect.height < this.areaMinSize) {
        throw new Error("框选区域太小");
      }
      // V7.13：阶段诊断标记（失败时随 data.stage 返回）
      this.captureStage = "screenshot";
      var cropRect = new android.graphics.Rect(rect.left, rect.top, rect.right, rect.bottom);
      var file = presetFile || this.createScreenshotFile();
      var api = 0;
      try { api = android.os.Build.VERSION.SDK_INT; } catch(eApi) { api = 0; }
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
      // 截图捕获
      if (!bitmap && api >= 34) {
        try {
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
                   .setSize(cropRect.width(), cropRect.height())
                   .setFrameScale(1.0)
                   .setCaptureSecureLayers(true)
                   .setAllowProtected(true)
                   .setGrayscale(false)
                   .setExcludeLayers(null)
                   .setHintForSeamlessTransition(false);
            bitmap = bitmapFromHardwareBuffer(android.window.ScreenCapture.captureDisplay(builder.build()));
          } catch(e14old) {
            var builder2 = new android.window.ScreenCaptureInternal.DisplayCaptureArgs.Builder(displayToken);
            builder2.setPixelFormat(android.graphics.PixelFormat.RGBA_8888)
                    .setSourceCrop(cropRect)
                    .setSize(cropRect.width(), cropRect.height())
                    .setFrameScale(1.0)
                    .setSecureContentPolicy(0)
                    .setProtectedContentPolicy(0)
                    .setGrayscale(false)
                    .setExcludeLayers(null);
            bitmap = bitmapFromHardwareBuffer(android.window.ScreenCaptureInternal.captureDisplay(builder2.build()));
          }
        } catch(e14) { lastError = e14; bitmap = null; }
      }
      if (!bitmap && api >= 32) {
        try {
          var displayToken32 = android.view.SurfaceControl.getInternalDisplayToken();
          if (displayToken32 == null) throw new Error("无法获取 displayToken");
          var builder32 = new android.view.SurfaceControl.DisplayCaptureArgs.Builder(displayToken32);
          builder32.setPixelFormat(android.graphics.PixelFormat.RGBA_8888)
                   .setSourceCrop(cropRect)
                   .setSize(cropRect.width(), cropRect.height())
                   .setFrameScale(1.0)
                   .setCaptureSecureLayers(true)
                   .setAllowProtected(true)
                   .setGrayscale(false);
          bitmap = bitmapFromHardwareBuffer(android.view.SurfaceControl.captureDisplay(builder32.build()));
        } catch(e32) { lastError = e32; bitmap = null; }
      }
      if (!bitmap && api >= 29) {
        try {
          var displayToken29 = android.view.SurfaceControl.getInternalDisplayToken();
          if (displayToken29 == null) throw new Error("无法获取 displayToken");
          var sgBuffer = android.view.SurfaceControl.screenshotToBufferWithSecureLayersUnsafe(
            displayToken29, cropRect, cropRect.width(), cropRect.height(), false, 0
          );
          if (sgBuffer) {
            bitmap = android.graphics.Bitmap.wrapHardwareBuffer(
              sgBuffer.getGraphicBuffer(),
              android.graphics.ColorSpace.get(android.graphics.ColorSpace.Named.SRGB)
            );
          }
        } catch(e29) { lastError = e29; bitmap = null; }
      }
      if (!bitmap) {
        try {
          var sgBufferOld = android.view.SurfaceControl.screenshotToBuffer(
            cropRect, cropRect.width(), cropRect.height(), 0, java.lang.Integer.MAX_VALUE, false, 0
          );
          if (sgBufferOld) {
            bitmap = android.graphics.Bitmap.wrapHardwareBuffer(
              sgBufferOld.getGraphicBuffer(),
              android.graphics.ColorSpace.get(android.graphics.ColorSpace.Named.SRGB)
            );
          }
        } catch(eOld) { lastError = eOld; bitmap = null; }
      }
      if (!bitmap) {
        throw new Error("截图失败" + (lastError ? ": " + String(lastError) : ""));
      }
      this.captureStage = "save";
      this.saveBitmapToFile(bitmap, file);
      // V7.11.2：只保存 ShortX 私有目录（系统截图目录链实测不生效已移除）；
      // OCR 契约读同一文件，返回 JSON 协议不变
      return String(file.getAbsolutePath());
    };

    app.finishAreaCapture = function() {
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
        try { path = self.captureAreaToFile(self.areaFrozenCaptureRect, capFile); } catch(eCap) { err = eCap; }
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
            var fileObj = new java.io.File(String(path));
            var result = makeResult(true, "area_capture", "AREA_CAPTURE_SUCCESS", "框选截图成功", String(path), {
              name: String(fileObj.getName()),
              mime: "image/png",
              sizeBytes: Number(fileObj.length()),
              visualRect: rectObjToJson(self.areaFrozenVisualRect),
              captureRect: rectObjToJson(self.areaFrozenCaptureRect)
            });
            try { self.close(); } catch(eC2) {}
            finishWithJson(result);
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

    app.finishTextPick = function(picked) {
      var hp = this.hotspot();
      var rect = this.currentTextRect;
      var text = String(picked || "");
      var result = makeResult(true, "text_pick", "TEXT_PICK_SUCCESS", "取字成功", text, {
        hitPoint: pointToJson(hp.x, hp.y),
        rect: rectToJson(rect)
      });
      try { this.applyFrameState(1, true); } catch(eFrameReady) {}
      try { this.close(); } catch(eClose) {}
      finishWithJson(result);
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
      var now = (new Date()).getTime();
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
      var now = (new Date()).getTime();
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
      var now = (new Date()).getTime();
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
      // V7.21：清理 OCR 兜底状态（在途 OCR 线程回来后会被 closed 拦截）
      this.ocrBlocks = null;
      this.ocrBlocksAt = 0;
      this.ocrMissCount = 0;
      this.ocrRunning = false;
      this.a11yMissAt = 0; // V7.26：清理 a11y 未命中短记忆（会话结束即失效）
      this.a11yMissBase = 0; // V7.27：清理短记忆总寿命基准
      this.memoValidating = false; // V7.28：清理后台校验在途标志
      this.startingShown = false; // V7.33.3：清理 starting 一次性标志
      releasePointerActive(); // V7.33.4：释放单实例标志
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
      this.removeAreaCancelCatcher();
      // V7.18：拆除全屏触摸监视窗
      this.removePickWatcher();
      this.removePointerOverlayNow();
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
          var action = ev.getActionMasked();
          var rx = Math.round(ev.getRawX());
          var ry = Math.round(ev.getRawY());

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
              var moveDx = nextX - self.lastStableMoveX;
              var moveDy = nextY - self.lastStableMoveY;
              var moveDist = Math.sqrt(moveDx * moveDx + moveDy * moveDy);

              if (moveDist > self.moveStableThreshold) {
                self.lastStableMoveX = nextX;
                self.lastStableMoveY = nextY;
                if (!self.areaHasBeenDragged) {
                  self.areaHasBeenDragged = true;
                }
                self.resetAreaIdleTimer();
              }
              var hp2 = self.hotspotFromPointerXY(nextX, nextY);
              self.areaEndX = hp2.x;
              self.areaEndY = hp2.y;
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
              try { self.updateInspect(true); } catch(eUpLookup) {}
              var picked = self.commitRecentPick();
              if (!picked) {
                self.close();
                finishCancel("用户取消");
              }
            } else {
              self.close();
              finishCancel("用户取消");
            }
            return true;
          }
          return true;
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
      try { toastFeedbackOnMain("running"); } catch(eRunT) {}
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
      if (ret && ret.ok) {
        android.widget.Toast.makeText(context, "拖动指针到文字后松手取字；悬停1.5秒进入截图；截图模式下拖动选区后停止1.5秒自动退出", android.widget.Toast.LENGTH_LONG).show();
      } else {
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