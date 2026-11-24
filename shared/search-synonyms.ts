// Pure bilingual search synonyms, Traditional->Simplified folding, NL stopwords, and CJK lexicon.
// Erasable TypeScript only (Node --experimental-strip-types compatible, zero Node/Studio deps).

export interface SynonymCluster {
  readonly id: string;
  readonly terms: readonly string[];
  readonly related?: readonly string[];
}

export const TRADITIONAL_TO_SIMPLIFIED: Record<string, string> = {
  視: '视', 頻: '频', 動: '动', 畫: '画', 產: '产', 設: '设', 計: '计',
  講: '讲', 電: '电', 標: '标', 誌: '志', 傳: '传', 發: '发', 學: '学',
  數: '数', 據: '据', 圖: '图', 實: '实', 剪: '剪', 輯: '辑', 遊: '游',
  戲: '戏', 樂: '乐', 網: '网', 頁: '页', 簡: '简', 報: '报', 覺: '觉',
  介: '介', 維: '维', 廣: '广', 課: '课', 優: '优', 業: '业', 績: '绩',
  開: '开', 場: '场', 頭: '头', 帶: '带', 貨: '货', 買: '买', 賣: '卖',
  推: '推', 薦: '荐', 歷: '历', 記: '记', 錄: '录', 風: '风', 復: '复',
  創: '创', 醫: '医', 療: '疗', 飲: '饮', 飾: '饰', 碼: '码', 裝: '装',
  車: '车', 體: '体', 資: '资', 庫: '库', 樣: '样', 聲: '声', 轉: '转',
  鏡: '镜', 顏: '颜', 調: '调', 節: '节', 編: '编', 導: '导', 選: '选',
  擇: '择', 隱: '隐', 書: '书', 類: '类', 別: '别', 檢: '检', 語: '语',
  雜: '杂', 雙: '双', 紋: '纹', 專: '专', 組: '组',
  個: '个', 這: '这', 幫: '帮', 製: '制', 裡: '里', 麵: '面', 萬: '万',
  億: '亿', 無: '无', 與: '与', 為: '为', 從: '从', 進: '进', 點: '点',
  擊: '击', 顯: '显', 變: '变', 換: '换', 圓: '圆', 線: '线', 條: '条',
  張: '张', 閃: '闪', 爍: '烁', 輝: '辉', 響: '响', 應: '应', 機: '机',
  構: '构', 軟: '软', 雲: '云', 話: '话', 題: '题', 藝: '艺', 術: '术',
  會: '会', 議: '议', 館: '馆', 號: '号', 訊: '讯', 息: '息', 評: '评',
  測: '测', 試: '试', 驗: '验', 證: '证', 範: '范', 例: '例', 輪: '轮',
  廓: '廓', 環: '环', 境: '境', 鍵: '键', 盤: '盘', 鼠: '鼠', 飄: '飘',
  飛: '飞', 躍: '跃', 邊: '边', 際: '际', 聯: '联', 繫: '系', 總: '总',
  結: '结', 單: '单', 獨: '独', 屬: '属', 統: '统', 一: '一',
  國: '国', 華: '华', 漢: '汉',
};

// Longer sentence/phrase fillers stripped before tokenization when other content exists.
export const ZH_FILLER_PHRASES: readonly string[] = [
  '我想找一个', '我要做一个', '帮我找一个', '帮我推荐一个', '有没有适合做',
  '请问有没有', '给我推荐', '帮我找', '帮我做', '我想找', '我想要', '我想做',
  '我要找', '我要做', '请推荐', '能不能', '有没有', '可以用来', '适合用来',
  '相关的', '有关的', '风格的', '类型的', '类的', '的视频', '的模板', '的模版', '一个', '一些', '一款', '一种',
];

export const SEARCH_STOPWORDS_ZH: ReadonlySet<string> = new Set([
  '的', '了', '吗', '呢', '吧', '啊', '呀', '和', '与', '及', '或', '跟',
  '在', '是', '有', '为', '把', '被', '让', '给', '对', '从', '到', '向',
  '做', '找', '用', '想', '要', '做个', '找个', '个', '款', '种', '类',
  '适合', '关于', '相关', '类似', '推荐', '风格', '类型', '样式', '效果',
  '模板', '模版', '视频', '短片', '影片', '作品',
]);

export const SEARCH_STOPWORDS_EN: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'at', 'by',
  'with', 'about', 'from', 'as', 'into', 'like', 'find', 'search', 'show',
  'make', 'create', 'need', 'want', 'looking', 'template', 'templates',
  'video', 'videos', 'clip', 'clips', 'style', 'styles', 'type',
]);

// IMPORTANT: Keep `product-demo`, `product-launch`, and `brand-promo` disjoint
// so "产品演示" and "product promo" never falsely match "Brand promotion".
export const SYNONYM_CLUSTERS: readonly SynonymCluster[] = [
  // 1. Hot zero-result query: 口播
  {
    id: 'talking-head',
    terms: [
      '口播', '口播视频', '真人口播', '出镜', '出镜口播', '播讲', '主播', '自媒体口播',
      'a-roll', 'aroll', 'talking head', 'talking-head',
      'トーク', '語り', '토크', '말하기', 'sprecher',
    ],
  },
  // 2. Hot zero-result query: 科普
  {
    id: 'science-explainer',
    terms: [
      '科普', '知识科普', '科普视频', '知识讲解', '知识分享', '干货',
      '科学', 'science', 'science explainer', 'educational', 'infographic',
      '解説', 'インフォグラフィック', '과학', '인포그래픽',
      'wissenschaft', 'erklärvideo', 'infografik',
      'vidéo explicative', 'infographie',
      'наука', 'инфографика',
      'ciencia', 'explicativo', 'infografía',
      'ciência', 'infográfico',
      'scienza', 'esplicativo', 'infografica',
      'bilim', 'açıklayıcı',
    ],
  },
  // 3. Hot zero-result query: 电商
  {
    id: 'ecommerce',
    terms: [
      '电商', '带货', '电商带货', '商品展示', '好物推荐', '种草', '促销', '大促',
      '折扣', '黑五', '黑色星期五', '双十一', '双11', '618', '卖货',
      '网店', '商城', '购物', '电商海报', '主图视频',
      'ecommerce', 'e-commerce', 'shopping', 'discount', 'black friday',
      'ショッピング', '通販', 'セール', '割引', '쇼핑', '이커머스', '커머스', '할인', '세일',
      'onlineshop', 'rabatt', 'soldes', 'réduction',
      'интернет-магазин', 'скидка', 'распродажа',
      'comercio electrónico', 'descuento',
      'desconto', 'promoção', 'sconto',
      'e-ticaret', 'eticaret', 'ticaret', 'indirim', 'kampanya',
    ],
  },
  // 4. Hot zero-result query: 讲解
  {
    id: 'walkthrough-explain',
    terms: [
      '讲解', '解说', '产品讲解', '功能讲解', '教程', '教学视频', '操作演示',
      '使用指南', '说明书', '新手引导',
      'tutorial', 'walkthrough', 'how-to', 'howto', 'onboarding',
      'チュートリアル', '使い方', '튜토리얼', '사용법',
      'anleitung', 'tutoriel', 'инструкция', 'руководство', 'nasıl yapılır',
    ],
  },
  // 5. Hot zero-result query: vlog
  {
    id: 'vlog-shortform',
    terms: [
      'vlog', 'vlog日常', '生活记录', '旅拍', '探店', '打卡', '随拍',
      'tiktok', 'youtube shorts', 'diary',
      '브이로그', 'влог',
    ],
  },
  // 6. Hot zero-result query: logo
  {
    id: 'logo-intro',
    terms: [
      'logo', 'logo演绎', 'logo动画', 'logo reveal', 'logo animation',
      '标志', '双标志', '徽标', '商标', '品牌标志', '纹章',
      'emblem', 'monogram', 'wordmark', 'brand mark', 'crest', 'stinger',
      'ロゴ', '로고', 'логотип',
    ],
  },
  // 7. Disjoint: Product demo
  {
    id: 'product-demo',
    terms: [
      '产品演示', '功能演示', '软件演示', '应用演示', '界面演示', '产品demo',
      'product demo', 'product demos', 'feature demo', 'app demo', 'saas demo', 'ui demo',
      '製品デモ', '機能デモ', '제품 데모', '기능 데모',
      'produktdemo', 'démo produit', 'демо продукта',
      'demo de producto', 'demo de produto', 'demo prodotto', 'ürün demosu',
    ],
  },
  // 8. Disjoint: Product launch / product promo
  {
    id: 'product-launch',
    terms: [
      '产品宣传', '产品发布', '新品发布', '新品', '发布会', '上新', '首发', '发布片', '宣发',
      'product promo', 'product promotion', 'product launch', 'product launches',
      'launch film', 'launch video', 'product reveal', 'release video',
      'announcement film', 'keynote',
      '新製品', '製品発表', 'ローンチ', '신제품', '제품 출시', '런칭',
      'produkteinführung', 'lancement', 'запуск продукта',
      'lanzamiento', 'lançamento', 'lancio', 'ürün lansmanı',
    ],
  },
  // 9. Disjoint: Brand promotion (strictly no product-demo / product-promo overlap)
  {
    id: 'brand-promo',
    terms: [
      '品牌宣传', '品牌片', '品牌故事', '品牌形象', '企业宣传', '公司介绍', '形象片',
      'brand promotion', 'brand promo', 'brand film', 'brand story',
      'brand identity', 'branding', 'corporate film', 'company intro',
      'ブランド', 'ブランディング', '企業紹介', '브랜드', '브랜딩', '기업 소개',
      'marke', 'markenfilm', 'imagefilm', 'marque', 'film de marque',
      'бренд', 'корпоративный ролик', 'marca', 'video de marca', 'vídeo de marca',
      'video aziendale', 'marka filmi', 'kurumsal',
    ],
  },
  // 10. UI & SaaS Interface animation
  {
    id: 'ui-motion',
    terms: [
      '界面动效', 'ui动效', '交互', '交互动效', '软件', '应用', '网页展示', '后台',
      '仪表盘', '看板', '工作台', 'interface animation', 'ui animation', 'saas',
      'software', 'dashboard', 'webapp', 'mockup', 'browser', 'desktop', 'mobile app',
      'UIアニメーション', 'ダッシュボード', 'UI 애니메이션', '대시보드',
      'benutzeroberfläche', 'interface', 'интерфейс', 'interfaz', 'interfaccia', 'arayüz',
    ],
  },
  // 11. Text / Kinetic Typography
  {
    id: 'typography',
    terms: [
      '文字动效', '字体动效', '动态排版', '标题动画', '排版', '大字', '快闪', '文字快闪',
      'text animation', 'kinetic typography', 'typography', 'title card', 'headlines',
      'captions', 'kinetic',
      'タイポグラフィ', 'テキストアニメーション', '타이포그래피', '텍스트 애니메이션',
      'typografie', 'typographie', 'типографика', 'tipografía', 'tipografia', 'tipografi',
    ],
  },
  // 12. 3D motion
  {
    id: '3d-motion',
    terms: [
      '三维动效', '三维', '3d', '立体', '空间感', '渲染', '模型展示',
      '3d animation', 'three dimensional', 'spatial', 'perspective', 'webgl',
    ],
  },
  // 13. Graphic motion
  {
    id: 'graphic-motion',
    terms: [
      '图形动效', '几何', '扁平风', '矢量', '图形', '插画', '抽象', 'mg动画',
      'graphic animation', 'motion graphics', 'mograph', 'geometric', 'vector',
      'illustration', 'abstract',
    ],
  },
  // 14. Data & Milestones
  {
    id: 'data-milestones',
    terms: [
      '里程碑与业绩', '里程碑', '业绩', '战报', '年报', '年度总结', '复盘', '增长',
      '数据报告', '趋势', '指标', 'milestones and results', 'milestones', 'metrics',
      'kpi', 'growth', 'annual report', 'recap', 'wrapped', 'summary', 'revenue',
      '年間レポート', '実績', '연간 리포트', '성과', 'jahresbericht', 'meilenstein',
      'bilan', 'jalon', 'годовой отчёт', 'результаты', 'informe anual', 'hitos',
      'relatório anual', 'marcos', 'report annuale', 'yıllık rapor', 'kilometre taşı',
    ],
  },
  // 15. Partnership announcement
  {
    id: 'partnership',
    terms: [
      '合作公告', '联名', '战略合作', '生态合作', '官宣', '双品牌', '联合发布',
      'partnership announcement', 'partnership', 'collaboration', 'collab',
      'integration', 'co-brand',
    ],
  },
  // 16. Events & Campaigns
  {
    id: 'event-promo',
    terms: [
      '活动推广', '活动', '大会', '峰会', '黑客松', '直播预告', '邀约', '邀请函',
      '节日', '周年庆', 'event promotion', 'event', 'conference', 'summit',
      'hackathon', 'webinar', 'invitation', 'campaign', 'festival', 'holiday',
      'イベント', 'カンファレンス', '이벤트', '컨퍼런스', 'veranstaltung', 'konferenz',
      'événement', 'conférence', 'мероприятие', 'конференция', 'evento', 'conferencia',
      'conferência', 'conferenza', 'etkinlik', 'konferans',
    ],
  },
  // 17. Audio / Music / SFX / Voice (kept distinct between music/bgm and sfx/sound-effects)
  {
    id: 'audio-music',
    terms: [
      '音乐', '配乐', '背景音乐', '纯音乐', '曲子', '歌曲', '节拍', '旋律',
      'music', 'bgm', 'soundtrack', 'background music', 'beat', 'song', 'melody',
    ],
    related: ['音频', '声音', 'audio'],
  },
  {
    id: 'audio-sfx',
    terms: [
      '音效', '声效', '拟音', '环境音', '转场音效',
      'sfx', 'sound effect', 'sound effects', 'foley', 'ambience', 'whoosh',
    ],
    related: ['音频', '声音', 'audio'],
  },
  {
    id: 'audio-voice',
    terms: [
      '人声', '配音', '语音', '朗读', '旁白', '播客', '有声书',
      'voice', 'voiceover', 'tts', 'speech', 'podcast', 'narration', 'waveform', 'equalizer', '声波',
    ],
    related: ['音频', '声音', 'audio'],
  },
  // 18. Design Studio & Web / Deck
  {
    id: 'design-web',
    terms: [
      '网页', '网站', '落地页', '官网', '海报', '卡片', '组件', '专题页', '博客',
      'landing page', 'website', 'web page', 'hero', 'portfolio', 'poster', 'card',
      'pricing', 'saas landing',
    ],
  },
  {
    id: 'design-deck',
    terms: [
      '演示文稿', '路演', '融资', '方案', '汇报', '报告', '课件', '白皮书',
      'ppt', 'ppt模板', '幻灯片', 'slide', 'slides', 'deck', 'pitch deck',
      'presentation', 'report', 'document', 'editorial',
    ],
  },
  // 19. Games
  {
    id: 'game-genres',
    terms: [
      '游戏', '小游戏', '街机', '动作', '解谜', '益智', '跑酷', '射击', '卡牌', '多人',
      'game', 'arcade', 'action', 'puzzle', 'runner', 'shooter', 'platformer',
      'multiplayer', 'rpg', 'casual', 'retro', 'ゲーム', '게임',
    ],
  },
  // 20. Visual aesthetics / Styles
  {
    id: 'visual-styles',
    terms: [
      '极简', '简约', '高级感', '科技感', '未来感', '赛博朋克', '暗黑', '深色', '亮色', '浅色',
      '渐变', '玻璃', '毛玻璃', '霓虹', '复古', '像素', '杂志风', '现代',
      'minimal', 'minimalist', 'clean', 'modern', 'futuristic', 'tech', 'cyberpunk',
      'dark', 'light', 'gradient', 'neon', 'retro', 'pixel', 'swiss', 'editorial', 'sleek',
    ],
  },
  // 21. Video Skills / Workflows
  {
    id: 'skills-workflow',
    terms: [
      '去ai味', '文案', '脚本', '改写', '拆解', '长转短', '切片', '二创', '混剪',
      '复刻', '拉片', '分镜', 'de-ai', 'copywriting', 'script', 'teardown',
      'long-to-short', 'recreate', 'storyboard', 'hooks', 'viral',
    ],
  },
  // 22. Design & Deck multilingual
  {
    id: 'design-templates-i18n',
    terms: [
      'デザイン', 'テンプレート', '디자인', '템플릿', 'diseño', '模板', 'template',
      'plantilla', 'modèle', 'vorlage', 'шаблон', 'modelo', 'modello', 'şablon',
    ],
  },
];

// Built automatically from CJK substrings in clusters + curated domain compound words.
const EXTRA_CJK_LEXICON: readonly string[] = [
  '科技', '极简', '赛博', '复古', '高级', '创意', '商业', '医疗', '金融',
  '餐饮', '美妆', '服饰', '数码', '家居', '美食', '健身', '汽车', '房产',
  '国风', '二次元', '淘宝', '京东', '拼多多', '人工智能', '大模型', '智能体',
  '开放权重', '材质', '片尾', '片头', '转场', '边框', '标题', '封面',
  '对比', '榜单', '排行', '时间线', '工作流', '自动化', '素材', '字体',
  '品牌色', '配色', '图标', '网页版', '手机端', '横屏', '方屏',
];

function collectCjkTerms(): Set<string> {
  const lexicon = new Set<string>();
  const cjkRun = /[\u4e00-\u9fff]{2,}/g;
  for (const cluster of SYNONYM_CLUSTERS) {
    for (const term of cluster.terms) {
      for (const match of term.matchAll(cjkRun)) lexicon.add(match[0]);
    }
    for (const term of cluster.related ?? []) {
      for (const match of term.matchAll(cjkRun)) lexicon.add(match[0]);
    }
  }
  for (const word of EXTRA_CJK_LEXICON) {
    for (const match of word.matchAll(cjkRun)) lexicon.add(match[0]);
  }
  return lexicon;
}

export const CJK_LEXICON: ReadonlySet<string> = collectCjkTerms();
export const MAX_CJK_LEXICON_LENGTH: number = Array.from(CJK_LEXICON).reduce(
  (max, word) => (word.length > max ? word.length : max),
  2,
);
