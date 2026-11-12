/**
 * 全局可调参数（CONFIG）
 * ---------------------------------------------------------------------------
 * 这里集中了所有影响"画面观感 / 性能 / 地图尺度"的常量。
 * 想改画面风格或适配不同设备，优先改这里，而不用翻渲染代码。
 */

export const CONFIG = {
  /* ---------- 地图投影：经纬度 -> 世界坐标 ---------- */
  map: {
    lonMin: 99.0,       // 汉末版图西界（凉州 / 西域东端）
    lonMax: 124.0,      // 东界（辽东 / 东海）
    latMin: 20.0,       // 南界（交州 / 南海）
    latMax: 43.0,       // 北界（幽州 / 塞外）
    unitsPerDegree: 26, // 每经度对应的世界单位；整幅地图约 650 x 598 单位
    seaLevel: -3.2,     // 海面高度（地形低于此值即为水域）
  },

  /* ---------- 地形 ---------- */
  terrain: {
    heightRes: 384,      // 高度场采样分辨率（用于贴图、放置物、射线拾取）
    segments: 320,       // 地形网格细分（桌面）；移动端由 Quality 降为 180
    segmentsMobile: 180,
    textureSize: 2048,   // 地貌 + 州郡 + 势力 合成贴图尺寸
    overlaySize: 640,    // 势力归属 mask 分辨率（低分辨率计算后放大，节省启动时间）
    maxHeight: 34,       // 山脉最高隆起（世界单位）
    normalStrength: 0.95, // 法线贴图强度
  },

  /* ---------- 相机 ---------- */
  camera: {
    fov: 45,
    near: 1,
    far: 4200,
    start: { x: 30, y: 330, z: 430 }, // 初始机位（俯瞰中原）
    target: { x: 10, y: 0, z: -10 },
    minDistance: 42,
    maxDistance: 1050,
    minPolar: 0.10,      // 几乎可以垂直俯视
    maxPolar: 1.28,      // 不允许看到地平线以下，保证版图始终可读
    damping: 0.075,
  },

  /* ---------- 光照 / 大气 ---------- */
  lighting: {
    shadowMapSize: 2048,        // 桌面软阴影分辨率，移动端 1024
    shadowRadius: 3.2,
    startHour: 9.2,             // 初始时刻（24 小时制）
    dayLength: 240,             // 现实秒 / 一整天（自动昼夜循环）；设为 0 关闭自动
    fogDensity: 0.00082,    // 指数雾：远处山峦与地图边缘自然消隐，强化空气透视
    exposure: 1.05,
    shadowUpdateInterval: 1,    // 阴影贴图更新间隔（帧）；低画质档由 Quality 调为 2
  },

  /* ---------- 后处理 ---------- */
  post: {
    // high: 桌面独显；medium: 集显 / 平板；low: 手机
    // smaa: 线性空间子像素抗锯齿；aoIntensity: 烘焙 AO 强度（见 utils/textures.js）
    high:   { ssao: true,  bloom: true,  dof: true,  smaa: true,  maxPixelRatio: 1.75 },
    medium: { ssao: true,  bloom: true,  dof: false, smaa: true,  maxPixelRatio: 1.35 },
    low:    { ssao: false, bloom: false, dof: false, smaa: false, maxPixelRatio: 1.0  },
    pixelBudget: 2_900_000,     // 自适应像素比上限：高分辨率屏按总像素预算降采样
    hdrBloomThreshold: 1.0,     // 仅 HDR(>1) 像素起辉，避免白天整片发白
  },

  /* ---------- 材质 / 照片级写实 ---------- */
  material: {
    aoStrength: 0.74,           // 高度场烘焙 AO 强度（山谷、河谷、山脊接触阴影）
    aoMapIntensity: 0.95,       // three aoMapIntensity
    wetDarken: 0.55,            // 雨天湿土反照率衰减到 55%（水膜填充孔隙）
    wetRoughness: 0.42,         // 雨天粗糙度乘子
    wetReflect: 0.38,           // 湿地表菲涅尔天空反射强度（过高会让雨景发白）
  },

  /* ---------- 场景实例数量（性能开关）---------- */
  population: {
    // 桌面 / 移动端
    trees:      [5200, 1700],
    grass:      [26000, 5200],
    rocks:      [900, 260],
    soldiers:   [480, 170],
    cloudCover: 1.0,
  },

  /* ---------- 交互与可读性 ---------- */
  interaction: {
    labelFadeDistance: 620,  // 城池名标签淡出距离
    pickTolerancePx: 9,     // 拖拽超过该像素则视为移动镜头，不触发选中
    autoRotateSpeed: 0.12,
  },

  /* ---------- 季节 / 天气默认值 ---------- */
  season: '夏',   // 春 / 夏 / 秋 / 冬
  weather: '晴',  // 晴 / 阴 / 雨 / 雪
};

/** 季节视觉参数：植被色调、雪线、日照角度、雾浓度、水面色 */
export const SEASONS = {
  春: { tint: [0.86, 1.06, 0.80], snowLine: 0.86, sunHeight: 1.00, fog: 0.90, label: '春 · 万物萌生' },
  夏: { tint: [0.94, 1.00, 0.86], snowLine: 0.94, sunHeight: 1.18, fog: 1.00, label: '夏 · 草木蓊郁' },
  秋: { tint: [1.16, 0.90, 0.62], snowLine: 0.80, sunHeight: 0.86, fog: 1.10, label: '秋 · 五谷丰登' },
  冬: { tint: [0.80, 0.86, 0.96], snowLine: 0.42, sunHeight: 0.62, fog: 1.20, label: '冬 · 朔雪封山' },
};

/** 天气视觉参数：云量、太阳强度、雾倍数、降水类型 */
export const WEATHER = {
  // fog 倍数刻意收敛：照片级空气透视靠「远山渐隐」，而不是把整幅版图蒙成白雾
  晴: { cloud: 0.10, sun: 1.00, fog: 1.00, precip: null,  label: '晴 · 天朗气清' },
  阴: { cloud: 0.74, sun: 0.58, fog: 1.10, precip: null,  label: '阴 · 云低天沉' },
  雨: { cloud: 0.88, sun: 0.40, fog: 1.16, precip: 'rain', label: '雨 · 烟雨江东' },
  雪: { cloud: 0.82, sun: 0.54, fog: 1.12, precip: 'snow', label: '雪 · 风雪塞北' },
};

/** 势力：色值同时用于 3D 旗帜 / 边界 / HUD */
export const FACTIONS = {
  魏: { color: 0x2b5c8f, deep: 0x1b3c61, silk: 0x9dc0e6, name: '曹魏', capital: '洛阳', lord: '曹丕' },
  蜀: { color: 0xa63c31, deep: 0x6c231c, silk: 0xe9a08c, name: '蜀汉', capital: '成都', lord: '刘备' },
  吴: { color: 0x2f7a63, deep: 0x1d4d40, silk: 0x9dd6b8, name: '东吴', capital: '建业', lord: '孙权' },
  群: { color: 0x8a7654, deep: 0x584932, silk: 0xd7c49a, name: '群雄', capital: '—',     lord: '诸侯' },
};
