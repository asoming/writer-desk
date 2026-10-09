#!/usr/bin/env python3
"""Assemble the original, separately authored chapters into an editable v3 example."""
import base64
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "examples" / "novel"


def identifier(kind, value):
    return "tide-" + kind + "-" + hashlib.sha256(str(value).encode()).hexdigest()[:16]


def read_json(path):
    return json.loads(path.read_text("utf-8"))


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", "utf-8")


def assemble():
    bible = read_json(SOURCE / "story-bible.json")
    metadata = []
    for path in sorted(SOURCE.glob("*-metadata.json")):
        metadata.extend(read_json(path))
    metadata.sort(key=lambda item: item["number"])
    if [item["number"] for item in metadata] != list(range(1, 37)):
        raise SystemExit("Need finished, unique metadata for all 36 chapters before assembling.")
    known_names = {person[0] for person in bible["cast"]}
    chapters = []
    for item in metadata:
        number, title = item["number"], item["title"]
        body = (SOURCE / "chapters" / f"{number:02}.txt").read_text("utf-8").strip()
        lines = body.splitlines()
        # Some authored source files include their heading; the editor has its own title field.
        if lines and (lines[0].strip() == title or re.fullmatch(r"第[一二三四五六七八九十百\d]+章\s*" + re.escape(title), lines[0].strip())):
            body = "\n".join(lines[1:]).strip()
        count = sum(not char.isspace() for char in body)
        if count < 2600:
            raise SystemExit(f"Chapter {number} is unfinished ({count} characters).")
        unknown = set(item["characters"]) - known_names
        if unknown:
            raise SystemExit(f"Unknown characters in chapter {number}: {unknown}")
        chapters.append({"id": identifier("chapter", number), "title": f"第{number}章 {title}",
                         "body": body, "volumeId": identifier("volume", item["volume"]), "deletedAt": None})

    book = {"id": "tide-archive-original", "title": bible["title"], "kind": "long", "cover": "",
            "chapters": chapters, "volumes": [], "outline": [], "notes": [], "relations": []}
    cover = SOURCE / "cover.png"
    if cover.exists():
        book["cover"] = "data:image/png;base64," + base64.b64encode(cover.read_bytes()).decode()
    root_id = identifier("outline", "story")
    book["outline"].append({"id": root_id, "title": "全书总纲", "kind": "story", "volumeId": None,
                            "body": bible["premise"] + "\n\n" + bible["world"], "parentId": None,
                            "chapterIds": [], "deletedAt": None})
    for volume in bible["volumes"]:
        number = volume["number"]
        volume_id, outline_id = identifier("volume", number), identifier("outline", f"volume-{number}")
        summary = volume["days"] + "\n\n" + volume["end"]
        selected = [i for i in metadata if i["volume"] == number]
        book["volumes"].append({"id": volume_id, "title": volume["title"], "summary": summary, "deletedAt": None})
        book["outline"].append({"id": outline_id, "title": volume["title"], "kind": "volume", "volumeId": volume_id,
                                "body": summary, "parentId": root_id,
                                "chapterIds": [identifier("chapter", i["number"]) for i in selected], "deletedAt": None})
        for item in selected:
            body = item["summary"] + "\n\n视角人物　" + item["pov"] + "\n\n关键变化　" + item["turningPoint"]
            if item.get("foreshadowing"):
                body += "\n\n线索与照应\n" + "\n".join(item["foreshadowing"])
            book["outline"].append({"id": identifier("outline", item["number"]),
                                    "title": f"第{item['number']}章 {item['title']}", "kind": "chapter",
                                    "volumeId": volume_id, "body": body, "parentId": outline_id,
                                    "chapterIds": [identifier("chapter", item["number"])], "deletedAt": None})
    for title, body in [("世界规则与声段边界", "\n\n".join(bible["rules"])),
                        ("七个空位与证据", "沈峦、莫云已故。陈汀、秦澈、贺安幸存。两位已离城学生以学生甲、学生乙档案代号表示。\n\n证据须区分原件、口述、回放、录音和推测。九分钟结束后盐纸不能再次发声。"),
                        ("检验用说明", "这是完全虚构的原创长篇示例。每卷六章，共三十六章。\n\n可尝试调整卷章顺序、改名、从大纲与人物跳转正文、编辑别名后检查自动提及，以及导出再恢复备份。\n\n‘同章提及’包括回忆、谈论与转述，不等于人物实际在场。‘父亲’等泛称没有注册为人物别名。")]:
        book["outline"].append({"id": identifier("outline", title), "title": title, "kind": "scene", "volumeId": None,
                                "body": body, "parentId": None, "chapterIds": [], "deletedAt": None})

    for name, alias, group, role, desire, flaw, ending in bible["cast"]:
        related = [i for i in metadata if name in i["characters"]]
        arcs = []
        for volume in bible["volumes"]:
            selected = [i for i in related if i["volume"] == volume["number"]]
            if selected:
                arcs.append({"volumeId": identifier("volume", volume["number"]),
                             "body": "本卷关联事件\n\n" + "\n\n".join(f"第{i['number']}章 {i['title']}\n{i['summary']}" for i in selected)})
        book["notes"].append({"id": identifier("person", name), "type": "人物", "title": name,
                              "aliases": [alias] if alias not in ("父亲", "母亲") else [],
                              "body": f"{role}。\n\n目标　{desire}。\n\n矛盾　{flaw}。\n\n去向　{ending}。",
                              "profile": {"group": group, "role": role, "desire": desire, "flaw": flaw,
                                          "ending": ending, "arcs": arcs},
                              "chapterIds": [identifier("chapter", i["number"]) for i in related], "deletedAt": None})
    # These are authored story relationships, distinct from automatic co-mentions.
    relationships = [
        ("沈砚", "沈峦", "family", "父子", "追寻船票到接受记录的界限", "沈砚沿船票追查父亲的救援行动，最终承认材料无法证明死亡的最后一刻。"),
        ("沈砚", "唐霁", "cooperate", "档案与水路互证", "各自核查到共同复核", "两人以纸张来源、旧图、实测与居民口述相互核对，逐步建立可执行的方案。"),
        ("沈砚", "苏遥", "friend", "旧友", "互相照顾到尊重分工", "苏遥参与照护和撤离，沈砚在修复与救援之间学会承认自己的工作边界。"),
        ("沈砚", "白榆", "cooperate", "修复搭档", "试验争议到共同记录损失", "淡水保纸与晶纹留声冲突，两人保留试验记录，并在洪潮中共同取舍原件。"),
        ("沈砚", "韩铎", "conflict", "迁馆与保全", "移交期限到更正删节", "沈砚要求留下争议材料，韩铎逐步面对自己参与删节的责任。"),
        ("沈砚", "孟苇", "mentor", "修复与编目", "副目线索到恢复名卡", "孟苇交出手写副目并解释沉默，沈砚据此追查七个空位。"),
        ("沈砚", "江临", "cooperate", "修复与新编目", "怕错到保留待查", "两人建立新目录，区分已核实、待查与毁损，不把猜测补成原文。"),
        ("乔渡", "陈汀", "family", "母子", "追问隐瞒到重订生活分工", "陈汀承认主动下救援船，乔渡逐渐接受公开边界和生活选择由她决定。"),
        ("乔渡", "赵翎", "mentor", "邮路交接", "问路到共同投递", "赵翎向居民问路，接住乔渡留下的线路，两人重新核对灾后的投递地址。"),
        ("乔渡", "周岚", "cooperate", "街巷互助", "送通知到逐户撤离", "周岚的洗衣账提供旧案线索，两人在洪潮中落实住户转移和回执。"),
        ("唐霁", "林穗", "cooperate", "两张地图", "图纸偏见到居民共绘", "林穗提供窄渠与日常路线，唐霁把实测和生活经验一起放进新图。"),
        ("唐霁", "范启", "cooperate", "水路与闸房", "拒开旧闸到分段执行", "范启交代旧闸经验，唐霁与众人共同复核，再以回读方式开闸。"),
        ("唐霁", "庞勤", "cooperate", "水位见闻", "传闻到亲历核对", "庞勤辨清自己亲眼看见与听来的材料，协助复核旧泄水口。"),
        ("许照", "季川", "mentor", "师徒", "替徒隐瞒到主动停手复核", "旧灯号迟报与备用线路缺陷迫使两人改变独自承担错误的做法。"),
        ("季川", "余默", "cooperate", "灯号与无线电", "校时到备用联络", "共同校准计时与联络，危险线路停用后按既有备用方案恢复通话。"),
        ("许照", "范启", "cooperate", "旧闸值守者", "沉默到签图与回读", "两人面对十八年前的值守记录，在共同复核的图上留下自己的责任。"),
        ("苏遥", "温梨", "cooperate", "医务站同事", "过度承担到轮班", "疲劳和交接暴露问题后，两人设立清楚的照护轮换与责任记录。"),
        ("苏遥", "罗珊", "cooperate", "安置与照护", "空房争议到费用清单", "旅店安置须说明期限、费用和照护分工，双方把承诺落实成名单。"),
        ("温梨", "田弥", "cooperate", "照护与夜校", "临时撤离到常规轮换", "田弥与学生参与名单核对，灾后迁课和照护继续保留交接。"),
        ("陆衡", "魏峤", "conflict", "账款与承包", "差额对质到追偿欠薪", "陆衡用账本证明检修款去向，魏峤须承担旧账和工人工资，退出封闸。"),
        ("顾棠", "陆衡", "cooperate", "证据与报道", "核验到实名承担", "顾棠逐项核对账款，陆衡拒绝以匿名换取继续工作的安排。"),
        ("顾棠", "梁笙", "cooperate", "刊印与录音", "采集冲突到许可审阅", "两人把可核验材料与私人内容分开处理，未获许可的私事不能进入报道。"),
        ("梁笙", "陈汀", "conflict", "记录的边界", "未经允许到见证删除", "陈汀要求保留自己叙述的决定，梁笙按许可范围整理录音和删除目录。"),
        ("秦澈", "邵闻", "conflict", "学生与旧校教师", "逃课污名到更正名册", "秦澈纠正旧记录，邵闻交出点名册，说明学生参与救援。"),
        ("秦澈", "莫云", "mentor", "旧校师生", "失实记载到恢复救援事实", "材料确认莫云折返救助，秦澈要求学生行动被准确记录。"),
        ("贺安", "范启", "cooperate", "替班与闸工", "副条核验到共同开闸", "贺安交出指令副条，并在洪潮中参加每一步开闸指令的复核。"),
        ("孟苇", "韩铎", "conflict", "名卡删节", "沉默保人到共同担责", "两人须分别解释抽走名卡和删去迟报环节的行为，不能用新目录掩过。"),
        ("段青", "赵翎", "cooperate", "路线通知", "省纸到按街巷印制", "告示与投递中发现老人无法使用统一路线，重印后逐户说明。"),
        ("姚远", "魏峤", "cooperate", "修船与旧合作", "不肯作证到转运", "姚远交出修船账，魏峤开放货场，两人的旧合作仍须核清。"),
        ("齐朔", "韩铎", "cooperate", "迁馆承运", "签收到先搬人", "原迁馆日期和路线被取消，承运优先保障住户与易损档案。"),
        ("周岚", "罗珊", "cooperate", "下湾安置", "各自守屋到逐户互助", "两人组织街巷住户撤离，说明现实损失和接续安排。"),
        ("林穗", "田弥", "mentor", "夜校师生", "校舍隐患到迁课", "田弥公开失修问题，林穗的街巷经验参与新图和灾后安排。"),
        ("陈汀", "姚远", "cooperate", "旧救援与修船账", "回避到核验", "修船账与陈汀口述相互核对，澄清救援船和临时上岸的行动。"),
        ("沈峦", "莫云", "cooperate", "白沙渡救援者", "当夜行动到事后核实", "两人折返救助而亡。声段、点名和修船记录只能证明各自保留的部分。"),
        ("余默", "贺安", "cooperate", "指令复核", "只重复到确认来源", "无线电与闸房逐条回读，记录发令者和执行情况。"),
    ]
    for a, b, kind, label, stage, body in relationships:
        related = [i for i in metadata if a in i["characters"] and b in i["characters"]]
        book["relations"].append({"id": identifier("relation", a + b), "fromId": identifier("person", a),
                                  "toId": identifier("person", b), "type": kind, "label": label, "stage": stage,
                                  "body": body, "volumeIds": [identifier("volume", v) for v in sorted({i["volume"] for i in related})],
                                  "chapterIds": [identifier("chapter", i["number"]) for i in related], "deletedAt": None})
    for title, kind, body in [("蓼港与下湾", "地点", bible["world"]), ("盐纸规则", "世界观", "\n\n".join(bible["rules"]))]:
        book["notes"].append({"id": identifier("note", title), "type": kind, "title": title, "body": body,
                              "aliases": [], "chapterIds": [], "deletedAt": None})

    sys.path.insert(0, str(ROOT))
    from server import validate_book
    assert validate_book(book) == book
    count = sum(sum(not char.isspace() for char in c["body"]) for c in chapters)
    if count < 100000:
        raise SystemExit(f"Novel requires roughly 100,000 characters; currently {count}.")
    backup = {"format": "yejian-backup", "version": 3, "book": book}
    write_json(ROOT / "examples" / "tide-archive.yejian.json", backup)
    write_json(ROOT / "examples" / "manifest.json", [{"id": "tide-archive", "title": bible["title"],
               "englishTitle": bible["englishTitle"], "volumeCount": 6, "chapterCount": 36, "personCount": 32, "charCount": count}])
    manuscript = bible["title"] + "\n" + bible["englishTitle"] + "\n\n原创虚构示例小说\n\n"
    for volume in book["volumes"]:
        manuscript += volume["title"] + "\n\n"
        for c in chapters:
            if c["volumeId"] == volume["id"]:
                manuscript += c["title"] + "\n\n" + c["body"] + "\n\n"
    (ROOT / "examples" / "潮汐档案馆.txt").write_text(manuscript.rstrip() + "\n", "utf-8")
    print(json.dumps({"characters": count, "chapters": 36, "people": 32, "relations": len(relationships)}, ensure_ascii=False))


if __name__ == "__main__":
    assemble()
