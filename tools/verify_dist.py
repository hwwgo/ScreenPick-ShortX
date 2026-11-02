#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""校验 dist/ 下的发行文件。

检查四件事：
  1. 导入文件能被解析：`###------###` 之前是合法 JSON，之后是动作尾；
  2. `versionCode` 与版本对应（v7.33.11 = 50，v7.80 = 108）；
  3. 导入文件里的 `expression` 与同目录母版 js **逐字节一致**；
  4. SHA256SUMS.txt 里的哈希与文件一致。

用法：python3 tools/verify_dist.py
退出码：0 全过，1 有失败项。
"""
import hashlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEP = "###------###"
VERSIONS = {"v7.33.11": 50, "v7.80": 108}

fails = []
checks = 0


def check(ok, label):
    global checks
    checks += 1
    if not ok:
        fails.append(label)
    print(("  ok   " if ok else "  FAIL ") + label)


def one(d, ext):
    names = sorted(f for f in os.listdir(d) if f.endswith(ext))
    if len(names) != 1:
        return None
    return os.path.join(d, names[0])


for ver, expected_vc in VERSIONS.items():
    d = os.path.join(ROOT, "dist", ver)
    print(f"[{ver}]")
    if not os.path.isdir(d):
        check(False, f"{ver}: 目录不存在")
        continue
    txt_path, js_path = one(d, ".txt"), one(d, ".js")
    check(txt_path is not None and js_path is not None, f"{ver}: 导入文件与母版各一份")
    if not txt_path or not js_path:
        continue

    raw = open(txt_path, encoding="utf-8").read()
    check(raw.count(SEP) == 1, f"{ver}: 分隔行恰好一处")

    try:
        head = json.loads(raw[: raw.index(SEP)])
        check(True, f"{ver}: 头部 JSON 可解析")
    except Exception as exc:  # noqa: BLE001
        check(False, f"{ver}: 头部 JSON 可解析（{exc}）")
        continue

    check(str(head.get("versionCode")) == str(expected_vc),
          f"{ver}: versionCode = {expected_vc}（实际 {head.get('versionCode')}）")
    check(head.get("title") == "屏幕取字", f"{ver}: title = 屏幕取字")

    actions = head.get("actions") or []
    check(len(actions) == 2, f"{ver}: actions 两个（ExecuteJS + SwitchCase）")
    if len(actions) == 2:
        check(actions[0].get("@type", "").endswith("ExecuteJS"), f"{ver}: 第一个动作是 ExecuteJS")
        check(actions[1].get("@type", "").endswith("SwitchCase"), f"{ver}: 第二个动作是 SwitchCase")

    js = open(js_path, encoding="utf-8").read()
    check(actions and actions[0].get("expression") == js,
          f"{ver}: expression 与母版逐字节一致")

print("[SHA256SUMS.txt]")
sums = os.path.join(ROOT, "SHA256SUMS.txt")
if not os.path.isfile(sums):
    check(False, "SHA256SUMS.txt 存在")
else:
    bad = 0
    n = 0
    for line in open(sums, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        digest, path = line.split("  ", 1)
        n += 1
        full = os.path.join(ROOT, path)
        if not os.path.isfile(full):
            bad += 1
            print(f"  FAIL 缺失 {path}")
        elif hashlib.sha256(open(full, "rb").read()).hexdigest() != digest:
            bad += 1
            print(f"  FAIL 哈希不符 {path}")
    checks += n
    check(bad == 0, f"SHA256 {n} 项全部匹配")

print()
if fails:
    print(f"✗ {len(fails)} 项失败 / 共 {checks} 项")
    sys.exit(1)
print(f"✓ {checks} 项全部通过")
