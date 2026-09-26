/* 设置：上面是常用的（AI 理解的你、简报、通知、阅读、订阅地址、账户），其余收在「高级设置」里。
 * 兴趣描述不用自己改：用一句话告诉 AI 想多看 / 少看什么，下次运行时由模型改写进去（feedhub/interests.py）。 */
import {
  h, icon, iconButton, segmented, switchControl, autoGrow, copyText, toast, fmtTime, nodes, openDialog, wheelPicker,
} from '../../assets/ui.js';
import {
  S, markDirty, setReadingFont, setReadingSize, READING_SIZES, outputFeeds, briefingMode,
  loadInterestHistory, requestInterestChange, undoInterestChange,
} from '../store.js';
import { explain } from '../api.js';
import { pageHead } from '../common.js';
import { requestLogout, navigate } from '../nav.js';

const SIZE_LABELS = { sm: '小', md: '标准', lg: '大', xl: '特大' };

const pad2 = (n) => String(n).padStart(2, '0');
// 和 feedhub/briefing.py 的 edition_title 一致
const editionName = (hour) => (hour < 11 ? '早报' : hour < 16 ? '午报' : '晚报');

/** 推送时间的滚轮：只选整点（每小时运行一次，分钟没有意义），后面固定显示「:00」。 */
function hourPicker(hour) {
  const wheel = wheelPicker({
    items: Array.from({ length: 24 }, (_, hr) => ({ value: hr, label: pad2(hr) })),
    value: hour,
    label: '几点',
  });
  const el = h('div', { class: 'time-picker' }, wheel.el, h('span', { class: 'time-picker-min', 'aria-hidden': 'true' }, ':00'));
  return { el, get value() { return wheel.value; } };
}
const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? 0 : n;
};

/** 在 Reeder 里订阅的地址：全部、重要、简报、每个分组，外加一次订阅全部的 OPML。 */
function subscriptions() {
  const outs = outputFeeds();
  if (!outs.length) {
    return h('section', { class: 'settings-section' }, h('h2', { class: 'settings-title' }, '订阅地址'),
      h('p', { class: 'hint settings-hint' }, '先在下面「输出」里填上站点地址（GitHub Pages 地址），这里就会列出订阅地址。'));
  }
  const opml = outs[0].url.replace(/all\.xml$/, 'index.opml');
  const row = (name, url) => h('li', { class: 'url-row' },
    h('span', { class: 'url-name' }, name),
    h('span', { class: 'url-value mono' }, url),
    iconButton('copy', `复制「${name}」的地址`, () => copyText(url, '地址已复制'), { small: true }));
  return h('section', { class: 'settings-section' },
    h('h2', { class: 'settings-title' }, '订阅地址'),
    h('p', { class: 'hint settings-hint' }, briefingMode()
      ? '在 Reeder 里订阅「简报与重磅」一个地址就够了：每天几期简报，加上偶尔的重磅消息。以前订阅的分组地址还在，但不会再有新文章，可以删掉。'
      : '在 Reeder 里添加这些地址。想少收一些，只订「简报」和「重要」就够了；想一次订阅所有分组，就导入最后的 OPML。'),
    h('ul', { class: 'url-list' }, outs.map((o) => row(o.name, o.url)), row('OPML（全部）', opml)));
}

export function SettingsPage() {
  const s = S.settings;
  const { filter, translate, output, llm, site } = s;
  if (!s.digest || typeof s.digest !== 'object') s.digest = {};
  const digest = s.digest;
  if (!s.fulltext || typeof s.fulltext !== 'object') s.fulltext = { reader: 'https://r.jina.ai/' };
  if (!s.delivery || typeof s.delivery !== 'object') s.delivery = {};
  const delivery = s.delivery;

  /** 把输入框绑定到配置对象上，改动即标记为未保存。 */
  function bind(obj, key, el, parse = (v) => v) {
    const update = () => {
      obj[key] = parse(el.type === 'checkbox' ? el.checked : el.value);
      markDirty('settings');
    };
    el.addEventListener('input', update);
    el.addEventListener('change', update);
    return el;
  }

  function field(label, control, hint = '') {
    return h('div', { class: 'field' }, h('label', { class: 'label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
  }

  function range(label, obj, key, hint) {
    const out = h('output', {}, obj[key]);
    const input = h('input', { type: 'range', min: 0, max: 10, step: 1, value: obj[key] ?? 0, 'aria-label': label });
    bind(obj, key, input, toInt);
    input.addEventListener('input', () => { out.textContent = input.value; });
    return h('div', { class: 'field' }, h('label', { class: 'label' }, label), h('div', { class: 'range' }, input, out), h('span', { class: 'hint' }, hint));
  }

  function number(obj, key, min = 1) {
    return bind(obj, key, h('input', { class: 'input', type: 'number', min, value: obj[key] ?? '' }), toInt);
  }

  function section(title, hint, ...children) {
    return h('section', { class: 'settings-section' },
      h('h2', { class: 'settings-title' }, title),
      hint ? h('p', { class: 'hint settings-hint' }, hint) : null,
      ...children);
  }

  const interests = bind(s, 'interests', h('textarea', { class: 'textarea textarea-serif interests', rows: 12, value: s.interests || '', 'aria-label': '兴趣描述' }));
  interests.addEventListener('input', () => autoGrow(interests));

  const mode = segmented({
    items: [{ value: 'translated', label: '只看中文' }, { value: 'bilingual', label: '中英对照' }],
    value: translate.mode === 'bilingual' ? 'bilingual' : 'translated',
    label: '翻译显示方式',
    onChange: (v) => { translate.mode = v; markDirty('settings'); },
  });

  const deliveryMode = segmented({
    items: [{ value: 'briefing', label: '简报 + 重磅' }, { value: 'articles', label: '逐篇推送' }],
    value: delivery.mode === 'articles' ? 'articles' : 'briefing',
    label: '推送方式',
    onChange: (v) => { delivery.mode = v; markDirty('settings'); },
  });
  const breaking = bind(delivery, 'breaking', h('textarea', {
    class: 'textarea', rows: 4, value: delivery.breaking || '', 'aria-label': '什么算重磅',
    placeholder: '留空用默认标准：只有特大、罕见、会改变格局的消息才算，比如东契奇被交易这种级别的球星交易、Apple Intelligence 在中国大陆的 iOS（包括测试版）里可以用了；常规发布、财报、融资、评测和没证实的传闻都不算。',
  }));
  breaking.addEventListener('input', () => autoGrow(breaking));

  const tables = segmented({
    items: [{ value: 'list', label: '改成列表' }, { value: 'table', label: '保留表格' }],
    value: output.tables === 'table' ? 'table' : 'list',
    label: '表格显示方式',
    onChange: (v) => { output.tables = v; markDirty('settings'); },
  });

  /** 术语表：每行「原文 → 译名」，可以增删。 */
  function glossaryEditor() {
    if (!Array.isArray(translate.glossary)) translate.glossary = [];
    const rows = h('div', { class: 'glossary' });
    const add = h('button', {
      type: 'button', class: 'btn btn-secondary glossary-add',
      onclick: () => {
        translate.glossary.push({ src: '', dst: '' });
        markDirty('settings');
        draw();
        rows.querySelector('.glossary-row:last-child input')?.focus();
      },
    }, icon('plus'), '添加术语');
    function draw() {
      rows.replaceChildren(...translate.glossary.map((entry, idx) => h('div', { class: 'glossary-row' },
        h('input', {
          class: 'input', value: entry.src || '', placeholder: '原文，比如 Kyrie Irving', 'aria-label': `第 ${idx + 1} 条的原文`,
          oninput: (e) => { entry.src = e.target.value; markDirty('settings'); },
        }),
        h('span', { class: 'glossary-arrow', 'aria-hidden': 'true' }, '→'),
        h('input', {
          class: 'input', value: entry.dst || '', placeholder: '译名，比如 凯里·欧文', 'aria-label': `第 ${idx + 1} 条的译名`,
          oninput: (e) => { entry.dst = e.target.value; markDirty('settings'); },
        }),
        h('button', {
          type: 'button', class: 'btn btn-icon btn-sm', 'aria-label': `删除第 ${idx + 1} 条`,
          onclick: () => { translate.glossary.splice(idx, 1); markDirty('settings'); draw(); },
        }, icon('x')))));
    }
    draw();
    return h('div', { class: 'field' }, h('span', { class: 'label' }, '术语表'), rows, add,
      h('span', { class: 'hint' }, '标题、要点和正文都按这里的译名翻译。译名和原文写成一样，表示保留原文不翻译。'));
  }

  const themeHost = h('div');
  window.FeedHubTheme?.mountSwitcher(themeHost);
  const font = segmented({
    items: [{ value: 'serif', label: '衬线' }, { value: 'sans', label: '无衬线' }],
    value: S.readingFont,
    label: '阅读字体',
    onChange: (v) => setReadingFont(v),
  });

  const size = segmented({
    items: READING_SIZES.map((v) => ({ value: v, label: SIZE_LABELS[v] })),
    value: S.readingSize,
    label: '字号',
    onChange: (v) => setReadingSize(v),
  });

  /** 推送时间：像 iPhone 闹钟一样一条条列出；点一条用滚轮改，「添加时间」再加一条，× 删掉（至少留一条）。 */
  function scheduleField() {
    const list = h('ul', { class: 'time-list' });
    const hours = () => [...new Set((digest.hours?.length ? digest.hours : [7, 19]).map(Number))].sort((a, b) => a - b);
    const store = (next) => {
      digest.hours = [...new Set(next)].sort((a, b) => a - b);
      markDirty('settings');
      draw();
    };
    // 新加的一条先停在中午之后第一个空着的整点
    const suggest = () => {
      const used = new Set(hours());
      for (let i = 0; i < 24; i += 1) if (!used.has((12 + i) % 24)) return (12 + i) % 24;
      return 12;
    };

    function edit(current, anchor) {
      const picker = hourPicker(current ?? suggest());
      openDialog({
        title: current == null ? '添加推送时间' : '修改推送时间',
        description: '北京时间，整点出一期。',
        body: picker.el,
        sheet: true,
        anchor,
        actions: [
          { label: '取消', variant: 'ghost', start: true },
          {
            label: current == null ? '添加' : '完成',
            variant: 'primary',
            onClick: () => {
              const others = hours().filter((x) => x !== current);
              if (others.includes(picker.value)) {
                toast(`已经有 ${pad2(picker.value)}:00 了`);
                return false;
              }
              store([...others, picker.value]);
              return true;
            },
          },
        ],
      });
    }

    function draw() {
      const all = hours();
      list.replaceChildren(...all.map((hr) => h('li', { class: 'time-row' },
        h('button', { type: 'button', class: 'time-main', 'aria-label': `${pad2(hr)}:00 ${editionName(hr)}，点按修改`, onclick: (e) => edit(hr, e.currentTarget) },
          h('span', { class: 'time-value' }, `${pad2(hr)}:00`),
          h('span', { class: 'time-name' }, editionName(hr))),
        all.length > 1 ? iconButton('x', `删除 ${pad2(hr)}:00`, () => store(all.filter((x) => x !== hr)), { small: true }) : null)));
    }
    draw();
    return h('div', { class: 'field' },
      h('span', { class: 'label' }, '推送时间'),
      list,
      h('button', { type: 'button', class: 'btn btn-secondary btn-sm time-add', onclick: (e) => edit(null, e.currentTarget) }, icon('plus'), '添加时间'),
      h('span', { class: 'hint' }, '北京时间。每期收录上一期之后通过筛选的文章；程序每小时运行一次，简报会在整点后半小时内送到。'));
  }

  /** AI 理解的你：兴趣描述只读显示；一句话告诉 AI 想多看 / 少看什么，下次运行时它改写进描述，改动可以撤销。 */
  function interestsCard() {
    const body = h('div', { class: 'interests-body' });
    const input = h('input', {
      class: 'input', maxlength: 200, 'aria-label': '想多看什么、少看什么',
      placeholder: '比如：NBA 交易传闻少推点，想多看固态电池',
    });
    const send = h('button', { type: 'submit', class: 'btn btn-primary' }, '告诉 AI');
    const form = h('form', {
      class: 'interests-ask',
      onsubmit: async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        send.disabled = true;
        try {
          await requestInterestChange(text);
          toast('已记下，几分钟内 AI 会把它改写进兴趣描述');
          navigate('#/settings'); // 配置换成了最新的一份，重建本页
        } catch (err) {
          toast(explain(err), { tone: 'danger' });
          send.disabled = false;
        }
      },
    }, input, send);

    async function undo(change) {
      try {
        await undoInterestChange(change);
        toast('已恢复成那次调整之前的描述');
        navigate('#/settings');
      } catch (err) {
        toast(explain(err), { tone: 'danger' });
      }
    }

    function drawCard() {
      const text = (S.settings.interests || '').trim();
      const pending = (S.settings.interest_requests || []).map((r) => (typeof r === 'string' ? r : r?.text)).filter(Boolean);
      const history = S.interestHistory || [];
      const last = history[history.length - 1];
      const canUndo = last && !last.undo && (S.settings.interests || '') === last.after;
      const full = h('div', { class: 'interests-text is-clamped' }, text || '还没有兴趣描述：AI 会按一般科技读者的标准打分。');
      const toggle = h('button', {
        type: 'button', class: 'btn btn-ghost btn-sm interests-toggle',
        onclick: () => { toggle.textContent = full.classList.toggle('is-clamped') ? '展开全文' : '收起'; },
      }, '展开全文');
      body.replaceChildren(...nodes(
        full, text.length > 180 ? toggle : null,
        pending.length ? h('p', { class: 'interests-pending' }, icon('sparkles'),
          `等 AI 处理（下次运行，通常几分钟内）：${pending.join('；')}`) : null,
        last ? h('p', { class: 'interests-last' },
          h('span', {}, `上次调整 ${fmtTime(last.at)}：${last.summary || last.requests?.join('；') || ''}`),
          canUndo ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => undo(last) }, icon('rotate-ccw'), '撤销') : null) : null,
      ));
    }
    cardRefresh = drawCard;
    drawCard();
    if (!S.interestHistory) loadInterestHistory();
    return h('section', { class: 'settings-section interests-card' },
      h('h2', { class: 'settings-title' }, 'AI 理解的你'),
      h('p', { class: 'hint settings-hint' }, 'AI 给每篇文章打分、编简报时都按这段描述判断。不用自己改：在下面用一句话告诉它想多看什么、少看什么。'),
      body, form);
  }
  let cardRefresh = null;

  const el = h('div', { class: 'page page-narrow settings' },
    pageHead('设置', '常用的都在这里。改动先暂存在本页，点底部「保存」后提交到仓库，并自动运行一次。'),

    interestsCard(),

    section('简报', '同一件事的多篇报道合成一条，AI 综合各来源写一段综述；值得读全文的单列为特稿（会翻译）；其余每篇一行。',
      h('label', { class: 'setting-row' },
        h('span', {}, h('span', { class: 'label' }, '生成简报'), h('span', { class: 'hint block' }, '关掉后只推送重磅消息。')),
        switchControl({ checked: digest.enabled !== false, label: '生成简报', onChange: (v) => { digest.enabled = v; markDirty('settings'); } })),
      scheduleField()),

    section('通知', null,
      h('label', { class: 'setting-row' },
        h('span', {}, h('span', { class: 'label' }, '推送到手机'), h('span', { class: 'hint block' },
          '每期简报出来、有重磅消息时推送一条。要先在 GitHub 私有仓库的 Settings → Secrets and variables → Actions 里添加 NOTIFY_URL：Bark App 里复制的地址，或 ntfy 的地址（https://ntfy.sh/ 加一个长而随机的名字）。')),
        switchControl({ checked: s.notify?.enabled !== false, label: '推送到手机', onChange: (v) => { s.notify = { ...(s.notify || {}), enabled: v }; markDirty('settings'); } }))),

    section('阅读', '主题、字体和字号只影响这台设备。',
      h('div', { class: 'field' }, h('span', { class: 'label' }, '主题'), themeHost),
      h('div', { class: 'field' }, h('span', { class: 'label' }, '字体'), font.el),
      h('div', { class: 'field' }, h('span', { class: 'label' }, '字号'), size.el, h('span', { class: 'hint' }, '文章正文和简报综述的大小；读文章时也可以点右上角的「Aa」调。')),
      h('div', { class: 'field' }, h('span', { class: 'label' }, '译文'), mode.el, h('span', { class: 'hint' }, '中英对照：每段原文下面跟着译文（像沉浸式翻译），列表项、表格单元格逐项对照；只对之后翻译的文章生效。在「全部文章」里点「翻译」的文章总是中英对照。'))),

    subscriptions(),

    section('账户', null,
      h('div', { class: 'setting-row' },
        h('span', {}, h('span', { class: 'label' }, S.repo), h('span', { class: 'hint block' }, `默认分支 ${S.branch} · ${S.user?.login ? `以 ${S.user.login} 登录` : ''}`)),
        h('button', {
          type: 'button', class: 'btn btn-secondary',
          onclick: requestLogout,
        }, icon('log-out'), '退出登录'))),

    // 平时不用动的放在这里，默认收起；要改也可以直接告诉 AI 助手
    h('details', {
      class: 'settings-advanced',
      // 收起时文本框量不出高度，展开时再按内容撑开
      ontoggle: (e) => { if (e.currentTarget.open) { autoGrow(interests); autoGrow(breaking); } },
    },
      h('summary', {}, icon('chevron-down'), '高级设置', h('span', { class: 'hint' }, '筛选门槛、推送方式、翻译、输出、模型')),

      section('兴趣描述原文', '上面「AI 理解的你」的原文，AI 打分和编简报都照着它。一般不用手改：用上面的一句话调整就行。',
        interests),

      section('推送方式', '简报 + 重磅：每天按时出几期简报，只有特大消息才单独推送，普通文章不翻译，只翻译特稿和重磅。逐篇推送：每篇通过筛选的文章都翻译、都进 feed。',
        h('div', { class: 'field' }, h('span', { class: 'label' }, '方式'), deliveryMode.el),
        field('什么算重磅', breaking, '模型打分时按这个标准判断。写得越具体越准；想多收一些就把标准放宽。'),
        h('div', { class: 'settings-grid' },
          field('一天最多几条重磅', bind(delivery, 'breaking_per_day', h('input', {
            class: 'input', type: 'number', min: 0, value: delivery.breaking_per_day ?? '', placeholder: '3',
          }), toInt), '防止标准写宽了刷屏。超出的按普通文章处理，进简报。填 0 不推重磅。'),
          field('头版最多几件事', number(digest, 'stories')))),

      section('筛选', null,
        range('推送门槛', filter, 'threshold', '达到这个分数的内容才会进入简报的素材。'),
        range('重要门槛', filter, 'important_threshold', '达到这个分数会在标题前加星标；逐篇推送时还会进入「重要」feed。'),
        h('div', { class: 'settings-grid' },
          field('只处理多少小时内发布的内容', number(filter, 'max_age_hours')),
          field('每个源每次最多处理几条', number(filter, 'max_new_per_feed'))),
        h('label', { class: 'setting-row' },
          h('span', {}, h('span', { class: 'label' }, '同一件事只推一篇'), h('span', { class: 'hint block' }, '多个来源报道同一件事时，只推信息量最大的一篇，其余作为「其他来源」附在文末。')),
          switchControl({ checked: filter.dedupe !== false, label: '同一件事只推一篇', onChange: (v) => { filter.dedupe = v; markDirty('settings'); } }))),

      section('翻译', null,
        h('div', { class: 'settings-grid' },
          field('每次运行最多翻译几篇', number(translate, 'max_articles_per_run'), '超出的排队，下次运行继续。'),
          field('单篇最多翻译多少字', number(translate, 'max_chars', 1000), '更长的只翻译前面部分，附上原文链接。'),
          field('每次运行每篇最多翻译多少字', number(translate, 'chars_per_run', 1000), '长文章先发布前面部分，之后的运行接着翻。')),
        glossaryEditor(),
        field('术语与风格', bind(translate, 'style_notes', h('textarea', { class: 'textarea', rows: 4, value: translate.style_notes || '' })),
          '更笼统的要求，比如哪一类词保留原文、语气怎么把握。具体的词写进上面的术语表。')),

      section('输出', null,
        h('div', { class: 'settings-grid' },
          field('站点地址', bind(site, 'url', h('input', { class: 'input mono-input', type: 'url', value: site.url || '' })), 'GitHub Pages 地址，用来生成订阅链接。'),
          field('每个 feed 保留几篇', number(output, 'items_per_feed', 10))),
        h('div', { class: 'field' }, h('span', { class: 'label' }, '表格'), tables.el,
          h('span', { class: 'hint' }, 'Reeder 等手机阅读器大多显示不了表格，会把单元格拆成一行行散字。改成列表后每行一项：第一列加粗，其余写成「表头：值」。下次运行时对已发布的文章也生效。')),
        field('备用抓取服务', bind(s.fulltext, 'reader', h('input', { class: 'input mono-input', type: 'url', value: s.fulltext.reader || '', placeholder: '留空则不用' })),
          'feed 只有摘要、原网页又直接抓不到（拒绝访问、正文靠 JavaScript 加载）时，通过这个服务再抓一次。默认 Jina Reader，免费但每分钟限 20 次；会把文章链接发给它。留空则不用。'),
        h('label', { class: 'setting-row' },
          h('span', {}, h('span', { class: 'label' }, '文章开头显示要点'), h('span', { class: 'hint block' }, 'AI 提炼的 2–3 条要点，在阅读器的列表里也能看到。')),
          switchControl({ checked: output.key_points !== false, label: '显示要点', onChange: (v) => { output.key_points = v; markDirty('settings'); } })),
        h('label', { class: 'setting-row' },
          h('span', {}, h('span', { class: 'label' }, '文章开头显示 AI 评分和理由'), h('span', { class: 'hint block' }, '在 Reeder 里能看到每篇为什么被推送。')),
          switchControl({ checked: !!output.show_score, label: '显示评分和理由', onChange: (v) => { output.show_score = v; markDirty('settings'); } }))),

      section('模型', 'DeepSeek：deepseek-flash 便宜够用；deepseek-v4-pro 质量更高、也更贵。任何 OpenAI 兼容接口都可以换进来。',
        h('div', { class: 'settings-grid' },
          field('打分模型', bind(llm, 'score_model', h('input', { class: 'input mono-input', value: llm.score_model || '' }))),
          field('翻译模型', bind(llm, 'translate_model', h('input', { class: 'input mono-input', value: llm.translate_model || '' })))),
        field('接口地址', bind(llm, 'base_url', h('input', { class: 'input mono-input', type: 'url', value: llm.base_url || '' }))))),
  );
  requestAnimationFrame(() => { autoGrow(interests); autoGrow(breaking); });
  return {
    el,
    refresh(what) {
      if (what.has('config')) cardRefresh?.();
    },
  };
}
