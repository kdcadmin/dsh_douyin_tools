"""回复评论的规矩（两个平台共用）：不超过 20 字；敏感话题委婉拒绝，不硬聊。

跑法（自检）：python tools/reply_policy.py
applies(text, comment) -> (ok, final_text, reason)
"""
from __future__ import annotations

import re

MAX_LEN = 20

# 敏感/不该接的话题：政治、民族宗教、医疗诊断、法律结论、隐私人肉、色情、赌博、金融荐股、代做违规事
SENSITIVE = [
    "政治", "政府", "领导人", "主席", "总统", "选举", "游行", "抗议", "六四", "台湾独立", "港独", "疆独",
    "民族", "宗教", "清真", "邪教",
    "病", "癌", "药", "治疗", "处方", "诊断", "医院", "抑郁", "自杀",
    "起诉", "律师", "判", "违法", "犯法", "坐牢", "报案", "赔偿",
    "身份证", "住址", "手机号", "人肉", "开盒", "社工", "查人",
    "裸", "色情", "约炮", "包养", "赌博", "博彩", "下注", "洗钱", "跑分",
    "股票", "荐股", "基金", "炒币", "贷款", "套现", "返利",
    "破解", "外挂", "盗号", "黑产", "刷单", "代考", "代写论文",
]

# 委婉拒绝的模板（都不超过 20 字，且不评判对方）
DECLINE = [
    "这个我不太方便聊，换个话题吧。",
    "抱歉，这条我不接了。",
    "这个我说不好，别问我啦。",
    "咱换个轻松点的聊吧。",
]


def _squash(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def is_sensitive(comment: str) -> bool:
    c = str(comment or "")
    return any(k in c for k in SENSITIVE)


def fit(text: str, limit: int = MAX_LEN) -> str:
    """压到 limit 字以内：优先在标点处断，其次硬裁。"""
    t = _squash(text)
    t = re.sub(r"@\S+\s*", "", t)  # 回复里不用再 @（回复本身就挂在对方下面）
    if len(t) <= limit:
        return t
    cut = t[:limit]
    for i in range(len(cut) - 1, max(0, len(cut) - 6), -1):
        if cut[i] in "，。！？~、,.!? ":
            return cut[:i].strip()
    return cut.strip()


def applies(text: str, comment: str) -> tuple[bool, str, str]:
    """返回 (能不能发, 最终文本, 原因)。"""
    if is_sensitive(comment):
        return True, DECLINE[hash(str(comment)) % len(DECLINE)], "敏感话题 ⇒ 委婉拒绝"
    final = fit(text)
    if not final:
        return False, "", "回复是空的"
    return True, final, "正常回复"


if __name__ == "__main__":
    cases = [
        ("谢谢喜欢～", "讲得真好", True),
        ("你这个问题问得好", "你对中国政治怎么看", True),
        ("这药怎么吃", "我妈得了癌症，吃什么药", True),
        ("哈哈确实是这样哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈", "更新好慢", True),
    ]
    ok_all = True
    for text, comment, _ in cases:
        ok, final, why = applies(text, comment)
        flag = "OK " if (ok and len(final) <= MAX_LEN) else "BAD"
        if not (ok and len(final) <= MAX_LEN):
            ok_all = False
        print(f"{flag} comment={comment!r} -> {final!r} ({len(final)} 字) [{why}]")
    print("PASS 回复规矩自检" if ok_all else "FAIL")
    raise SystemExit(0 if ok_all else 1)
