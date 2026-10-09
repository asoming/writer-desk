(function (root) {
  'use strict';

  // This module offers evidence to review. It never changes the supplied book.
  const MAX_CANDIDATES = 20;
  const MAX_EXCERPTS = 3;
  const HAN = '\\u3400-\\u9fff';
  const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于傅皮卞齐康伍余元卜顾孟平黄穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯管卢莫房裘缪解应宗丁宣邓郁单杭洪包左石崔吉龚程嵇邢裴陆荣翁荀羊甄曲封储靳段富焦巴牧山谷车侯全秋仲伊宫宁仇栾甘厉祖武符刘景詹束龙叶幸司韶黎乔白怀蒲邰从鄂索赖卓蔺蒙池谭胥能苍闻莘翟党劳姬申扶冉宰雍桑桂牛寿边燕冀郏浦尚农温庄晏瞿阎连茹习艾鱼容向古易慎戈廖庾终居衡步都耿满弘匡国文寇广禄阙东欧沃利师巩聂晁晃阚简饶曾关查游竺权盖桓公';
  const COMPOUND_SURNAMES = '欧阳|司马|上官|诸葛|东方|皇甫|尉迟|公孙|慕容|司徒|司空|夏侯|令狐|宇文|长孙|南宫|独孤|端木|轩辕|钟离';
  const ACTIONS = '说道|问道|笑道|答道|喊道|说|问|答|喊';
  const NARRATION_SUFFIXES = new Set('想却没点回说先差才去又把让这走正刚也仍便更只将再还不已曾就能要来抬');
  const NAME_PATTERN = new RegExp(
    '(^|[^' + HAN + 'A-Za-z0-9_])' +
    '((?:' + COMPOUND_SURNAMES + ')[' + HAN + ']{1,2}|[' + SURNAMES + '][' + HAN + ']{1,2})' +
    '(?=(?:' + ACTIONS + ')[：:，,。！？!?“”‘’\\s])', 'gm'
  );
  // Common words which can accidentally have the same shape as a Chinese name.
  const NON_NAMES = new Set((
    '高兴 高声 高处 高空 高山 高楼 高手 高大 高低 高举 高冷 高贵 ' +
    '方才 方向 方面 方法 方位 方圆 方便 方桌 方寸 ' +
    '周围 周身 周边 周末 周全 周遭 ' +
    '白天 白衣 白发 白光 白色 白雪 白纸 白云 白眼 白骨 白昼 ' +
    '林间 林中 林子 林边 林外 林里 林内 林木 林海 ' +
    '叶子 叶片 李子 王子 王爷 王后 王妃 王朝 王府 ' +
    '陈旧 张开 张嘴 张口 张望 张大 许多 许久 许是 ' +
    '夏日 夏天 夏季 春天 秋天 冬天 江边 江面 江水 江上 ' +
    '何时 何处 何人 何必 何况 何以 何不 何等 如何 ' +
    '余下 余光 余生 石头 石门 石壁 门口 后来 之后 之前 ' +
    '常常 常见 常年 安静 安心 安全 安然 安稳 尤其 尤为 ' +
    '沈默 沉默 杜绝 成为 成功 成败 成天 成群 成片 成员 成千 ' +
    '金色 金光 金属 金钱 黄昏 黄色 黄叶 黄沙 黄土 黑夜 ' +
    '景色 景象 容易 容颜 文中 文字 文本 文人 古代 古人 古老 ' +
    '温柔 温和 温暖 温度 明白 明天 明日 明亮 明明 宁可 宁愿 ' +
    '东方 西方 南方 北方 东边 西边 南边 北边 关上 关门 关闭 ' +
    '石阶 石板 石像 唐突 霍然 童年 幸好 幸而 幸福 公子 公主 公公 ' +
    '终于 当时 当下 此后 随后 最后 起初 一时 暂时 中间 外面 内部 后面 前面 半晌'
  ).split(/\s+/));

  function personNames(person) {
    const aliases = Array.isArray(person.aliases) ? person.aliases :
      typeof person.aliases === 'string' ? person.aliases.split(/[\n,，、;；|]+/) : [];
    return [...new Set([person.title, ...aliases]
      .filter(name => typeof name === 'string').map(name => name.trim()).filter(Boolean))];
  }

  // Aho–Corasick scans each chapter once, rather than once per registered name.
  function nameMatcher(people) {
    const nodes = [{ next: new Map(), fail: 0, names: new Set() }];
    const nameOwners = new Map();
    let maxNameLength = 0;
    for (const person of people) {
      for (const name of personNames(person)) {
        if (!nameOwners.has(name)) nameOwners.set(name, new Set());
        nameOwners.get(name).add(person.id);
        maxNameLength = Math.max(maxNameLength, name.length);
        let index = 0;
        for (const char of name) {
          if (!nodes[index].next.has(char)) {
            nodes[index].next.set(char, nodes.length);
            nodes.push({ next: new Map(), fail: 0, names: new Set() });
          }
          index = nodes[index].next.get(char);
        }
        nodes[index].names.add(name);
      }
    }
    const queue = [...nodes[0].next.values()];
    for (let head = 0; head < queue.length; head++) {
      const index = queue[head];
      for (const [char, child] of nodes[index].next) {
        queue.push(child);
        let fallback = nodes[index].fail;
        while (fallback && !nodes[fallback].next.has(char)) fallback = nodes[fallback].fail;
        nodes[child].fail = nodes[fallback].next.get(char) || 0;
        for (const name of nodes[nodes[child].fail].names) nodes[child].names.add(name);
      }
    }
    return {
      nameOwners,
      find(text) {
        const found = new Set();
        const ambiguous = new Set();
        if (!maxNameLength) return { people: found, ambiguous };
        // Keep only a name-length window of matches. At a given position the
        // longest registered name wins; its shorter overlapping names are skipped.
        const pending = new Map();
        let nextStart = 0;
        let position = 0;
        let index = 0;
        function flush(until) {
          while (nextStart <= until) {
            const match = pending.get(nextStart);
            pending.delete(nextStart++);
            if (!match) continue;
            const owners = nameOwners.get(match.name);
            if (owners.size === 1) found.add(owners.values().next().value);
            else ambiguous.add(match.name);
            while (nextStart < match.end) pending.delete(nextStart++);
          }
        }
        for (const char of text) {
          position += char.length;
          while (index && !nodes[index].next.has(char)) index = nodes[index].fail;
          index = nodes[index].next.get(char) || 0;
          for (const name of nodes[index].names) {
            const start = position - name.length;
            if (start < nextStart) continue;
            if (!pending.has(start) || pending.get(start).name.length < name.length) {
              pending.set(start, { name, end: position });
            }
          }
          flush(position - maxNameLength);
        }
        flush(position);
        return { people: found, ambiguous };
      }
    };
  }

  function pairKey(a, b) {
    return JSON.stringify([a, b].sort());
  }

  function excerpt(text, start, nameLength) {
    const from = Math.max(0, start - 32);
    const to = Math.min(text.length, start + nameLength + 44);
    return (from ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ').trim() +
      (to < text.length ? '…' : '');
  }

  function analyzeBook(book) {
    const people = (Array.isArray(book?.notes) ? book.notes : [])
      .filter(person => person && person.type === '人物' && !person.deletedAt && typeof person.id === 'string');
    const chapters = (Array.isArray(book?.chapters) ? book.chapters : [])
      .filter(chapter => chapter && !chapter.deletedAt && typeof chapter.id === 'string');
    const matcher = nameMatcher(people);
    const appearances = new Map(people.map(person => [person.id, []]));
    const existingPairs = new Set((Array.isArray(book?.relations) ? book.relations : [])
      .filter(relation => relation && !relation.deletedAt)
      .map(relation => pairKey(relation.fromId, relation.toId)));
    const cooccurrences = new Map();
    const candidates = new Map();
    const ambiguous = new Map();

    for (const chapter of chapters) {
      const text = typeof chapter.body === 'string' ? chapter.body : '';
      const mentions = matcher.find(text);
      const present = [...mentions.people].sort();
      for (const id of present) appearances.get(id).push(chapter.id);
      for (const name of mentions.ambiguous) {
        if (!ambiguous.has(name)) ambiguous.set(name, {
          name, personIds: [...matcher.nameOwners.get(name)], chapterIds: []
        });
        ambiguous.get(name).chapterIds.push(chapter.id);
      }
      // Pair enumeration is proportional to the requested co-occurrence evidence.
      for (let a = 0; a < present.length; a++) {
        for (let b = a + 1; b < present.length; b++) {
          const key = pairKey(present[a], present[b]);
          if (existingPairs.has(key)) continue;
          if (!cooccurrences.has(key)) cooccurrences.set(key, {
            fromId: present[a], toId: present[b], chapterIds: []
          });
          cooccurrences.get(key).chapterIds.push(chapter.id);
        }
      }

      // This deliberately misses names buried in unbroken Chinese text. Requiring
      // a boundary prevents taking an arbitrary suffix of a long Chinese phrase.
      NAME_PATTERN.lastIndex = 0;
      let match;
      while ((match = NAME_PATTERN.exec(text))) {
        const name = match[2];
        if (matcher.nameOwners.has(name) || NON_NAMES.has(name)) continue;
        // Greedy extraction can turn “沈砚想问” into a new name “沈砚想”.
        // Suppress this known-name + narrative-word shape, while retaining
        // genuine three-character candidates such as “林舟扬”.
        if (matcher.nameOwners.has(name.slice(0, -1)) && NARRATION_SUFFIXES.has(name.slice(-1))) continue;
        if (!candidates.has(name)) {
          if (candidates.size >= MAX_CANDIDATES) continue;
          candidates.set(name, { name, chapterIds: [], excerpts: [] });
        }
        const candidate = candidates.get(name);
        if (candidate.chapterIds[candidate.chapterIds.length - 1] !== chapter.id) {
          candidate.chapterIds.push(chapter.id);
          if (candidate.excerpts.length < MAX_EXCERPTS) candidate.excerpts.push({
            chapterId: chapter.id,
            text: excerpt(text, match.index + match[1].length, name.length)
          });
        }
      }
    }
    return {
      appearances: Object.fromEntries(appearances),
      cooccurrences: [...cooccurrences.values()],
      candidates: [...candidates.values()],
      ambiguous: [...ambiguous.values()]
    };
  }

  root.WriterAnalysis = Object.freeze({ analyzeBook });
})(typeof globalThis === 'object' ? globalThis : window);
